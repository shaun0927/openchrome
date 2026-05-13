/**
 * Extract Data Tool — Structured extraction API (#571)
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { waitForPageReady } from '../utils/page-ready-state';
import { extractMainContent, toMarkdown } from '../core/extract/html-to-markdown';
import { sanitizeContent } from '../security/content-sanitizer';
import { getDomainMemory, extractDomainFromUrl } from '../memory/domain-memory';
import {
  validateSchema,
  validateAndCoerce,
  buildJsonLdExtractor,
  buildMicrodataExtractor,
  buildOpenGraphExtractor,
  buildCssHeuristicExtractor,
  buildStandardDomExtractor,
  buildMultipleItemExtractor,
  parseExtractionMode,
  EXTRACTION_MODE_BUDGETS,
  buildSemanticHostExtractionPayload,
  SEMANTIC_DEFAULT_MAX_CHARS,
  SEMANTIC_HARD_MAX_CHARS,
} from '../extraction';
import type { ExtractionMode } from '../extraction';
import type { ExtractionSchema, SchemaProperty } from '../extraction';
import {
  OUTPUT_MODE_SCHEMA_PROPERTIES,
  parseOutputMode,
  resolveOutputMode,
} from './_shared/output-mode';

const definition: MCPToolDefinition = {
  name: 'extract_data',
  description:
    'Extract structured data with a JSON Schema from JSON-LD, Microdata, OpenGraph, or CSS. Use multiple:true for listings; mode="semantic" plus query for bounded host-side semantic chunks.\n\nWhen to use: Typed products, articles, prices, or semantic facts into a schema.\nWhen NOT to use: Use read_page for raw content or javascript_tool for ad-hoc scraping.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to extract from',
      },
      schema: {
        type: 'object',
        description:
          'JSON Schema defining output structure. ' +
          'Example: { "type": "object", "properties": { "title": { "type": "string" }, "price": { "type": "number" } } }',
      },
      instruction: {
        type: 'string',
        description: 'Optional natural language hint (e.g., "product details")',
      },
      query: {
        type: 'string',
        description: 'Required for mode="semantic": query describing the information to extract from a bounded markdown chunk',
      },
      maxChars: {
        type: 'number',
        description: `Semantic mode only: max chunk chars returned to the host. Default ${SEMANTIC_DEFAULT_MAX_CHARS}, hard cap ${SEMANTIC_HARD_MAX_CHARS}.`,
      },
      startFromChar: {
        type: 'number',
        description: 'Semantic mode only: continuation offset into filtered markdown. Default: 0.',
      },
      includeLinks: {
        type: 'boolean',
        description: 'Semantic mode only: preserve markdown links. Default: true.',
      },
      includeImages: {
        type: 'boolean',
        description: 'Semantic mode only: reserved for image markdown inclusion. Default: false.',
      },
      alreadyCollected: {
        type: 'array',
        description: 'Semantic mode only: values already collected by the host, used for simple chunk dedupe hints.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to scope extraction region',
      },
      multiple: {
        type: 'boolean',
        description: 'Extract array of items (for listings/tables). Default: false',
      },
      ...OUTPUT_MODE_SCHEMA_PROPERTIES,
    },
    required: ['tabId', 'schema'],
  },
  annotations: TOOL_ANNOTATIONS.extract_data,
};

function mergeResults(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if ((merged[key] === null || merged[key] === undefined || merged[key] === '') && value !== null && value !== undefined && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

function countFields(data: Record<string, unknown>): number {
  return Object.values(data).filter(v => v !== null && v !== undefined && v !== '').length;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  _context?: ToolContext
): Promise<MCPResult> => {
  // Mode validation (#989): validate before any browser/session interaction.
  const modeCheck = parseExtractionMode(args.mode);
  if (!modeCheck.ok) {
    return { content: [{ type: 'text', text: `Error: ${modeCheck.error}` }], isError: true };
  }
  const extractionMode = modeCheck.mode;
  const budget = EXTRACTION_MODE_BUDGETS[extractionMode];

  const tabId = args.tabId as string;
  const schema = args.schema as ExtractionSchema;
  const selector = args.selector as string | undefined;
  const query = args.query as string | undefined;
  const multiple = (args.multiple as boolean) ?? false;
  const { mode: outputMode, inlineLimit } = parseOutputMode(args);
  const waitForReady = args.waitForReady === true;
  const readyTimeoutMs = typeof args.readyTimeoutMs === 'number' ? args.readyTimeoutMs : undefined;

  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error: tabId is required' }], isError: true };
  }

  const schemaCheck = validateSchema(schema);
  if (!schemaCheck.valid) {
    return { content: [{ type: 'text', text: `Error: Invalid schema — ${schemaCheck.error}` }], isError: true };
  }

  const sessionManager = getSessionManager();
  const page = await sessionManager.getPage(sessionId, tabId, undefined, 'extract_data');
  if (!page) {
    const available = await sessionManager.getAvailableTargets(sessionId);
    const info = available.length > 0
      ? `\nAvailable tabs:\n${available.map(t => `  - tabId: ${t.tabId} | ${t.url} | ${t.title}`).join('\n')}`
      : '\nNo tabs available. Call navigate without tabId to create a new tab.';
    return { content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.${info}` }], isError: true };
  }

  try {
    const schemaProps: Record<string, SchemaProperty> = multiple
      ? (schema.items?.properties || schema.properties || {})
      : (schema.properties || {});
    // Sanitize field names to prevent CSS selector injection in strategy builders
    const safeFieldPattern = /^[a-zA-Z0-9_-]+$/;
    const fieldNames = Object.keys(schemaProps).filter(f => safeFieldPattern.test(f));

    if (fieldNames.length === 0) {
      return { content: [{ type: 'text', text: 'Error: Schema must define at least one property' }], isError: true };
    }

    let readiness: Awaited<ReturnType<typeof waitForPageReady>> | undefined;
    if (waitForReady) {
      readiness = await waitForPageReady(page, readyTimeoutMs ? { timeoutMs: readyTimeoutMs } : {}, _context);
    }

    const pageUrl = page.url();
    const domain = extractDomainFromUrl(pageUrl);

    if (extractionMode === 'semantic') {
      if (!query || query.trim().length === 0) {
        return { content: [{ type: 'text', text: 'Error: mode="semantic" requires a non-empty query' }], isError: true };
      }
      if (multiple) {
        return { content: [{ type: 'text', text: 'Error: mode="semantic" does not support multiple=true; use continuation metadata and alreadyCollected instead.' }], isError: true };
      }
      const includeLinks = args.includeLinks !== false;
      const html = selector
        ? await withTimeout(page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          return el ? (el as HTMLElement).outerHTML : '';
        }, selector) as Promise<string>, 15000, 'extract_data:semantic.selector', _context)
        : await withTimeout(page.content(), 15000, 'extract_data:semantic.content', _context);
      if (!html) {
        return { content: [{ type: 'text', text: `Error: selector "${selector}" did not match content for semantic extraction` }], isError: true };
      }
      const { html: cleaned } = extractMainContent(html, { onlyMainContent: !selector });
      const rawMarkdown = toMarkdown(cleaned, { includeLinks });
      const sanitized = sanitizeContent(rawMarkdown);
      const semanticPayload = buildSemanticHostExtractionPayload({
        markdown: sanitized.text + sanitized.sanitizationNote,
        schema,
        schemaProps,
        query,
        startFromChar: args.startFromChar as number | undefined,
        maxChars: args.maxChars as number | undefined,
        alreadyCollected: args.alreadyCollected as unknown[] | undefined,
      });
      const payload: Record<string, unknown> = {
        ...semanticPayload,
        url: pageUrl,
        selector: selector || undefined,
        includeLinks,
        includeImages: args.includeImages === true,
        readiness,
        metrics: { mode: 'semantic', outputChars: 0 },
      };
      const textWithoutMetrics = JSON.stringify(payload);
      payload.metrics = { mode: 'semantic', outputChars: textWithoutMetrics.length };
      const inlineResult: MCPResult = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      return resolveOutputMode(outputMode, inlineLimit, inlineResult, payload, 'extract_data');
    }

    // Multiple items mode
    if (multiple) {
      const multiScript = buildMultipleItemExtractor(fieldNames, schemaProps, selector);
      const rawItems = await withTimeout(page.evaluate(multiScript) as Promise<Record<string, unknown>[]>, 15000, 'extract_data');

      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            action: 'extract_data', url: pageUrl, multiple: true, items: [], count: 0,
            message: 'No repeating items found. Try a more specific selector or check if the page has loaded.',
          }) }],
        };
      }

      const itemSchema: ExtractionSchema = { type: 'object', properties: schemaProps, required: schema.items?.required || [] };
      const validated = rawItems.map(raw => validateAndCoerce(raw, itemSchema).result);

      const domainMemory = getDomainMemory();
      domainMemory.record(domain, `extract:multiple:${fieldNames.sort().join(',')}`, JSON.stringify({
        selector: selector || 'auto', fieldCount: fieldNames.length, itemCount: validated.length,
      }));

      const multiplePayload: Record<string, unknown> = {
        action: 'extract_data', url: pageUrl, multiple: true, items: validated, count: validated.length,
        modeUsed: extractionMode,
        ...(readiness ? { readiness } : {}),
      };
      const multipleTextWithoutMetrics = JSON.stringify(multiplePayload);
      multiplePayload.metrics = { mode: extractionMode, outputChars: multipleTextWithoutMetrics.length };
      const multipleInlineResult: MCPResult = {
        content: [{ type: 'text', text: JSON.stringify(multiplePayload) }],
      };
      return resolveOutputMode(outputMode, inlineLimit, multipleInlineResult, multiplePayload, 'extract_data');
    }

    // Single item — layered strategies
    let merged: Record<string, unknown> = {};
    const strategies: string[] = [];

    // Strategy 1: JSON-LD
    try {
      const r = await withTimeout(page.evaluate(buildJsonLdExtractor(fieldNames)) as Promise<Record<string, unknown>>, budget.jsonLdTimeoutMs, 'extract_data:jsonld');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('json-ld'); }
    } catch { /* non-fatal */ }

    if (countFields(merged) >= fieldNames.length) {
      const { result, validation } = validateAndCoerce(merged, schema);
      return buildResponseWithMode(result, validation.errors, pageUrl, strategies, domain, fieldNames, extractionMode, outputMode, inlineLimit, readiness);
    }

    // Strategy 2: Microdata
    try {
      const r = await withTimeout(page.evaluate(buildMicrodataExtractor(fieldNames)) as Promise<Record<string, unknown>>, budget.microdataTimeoutMs, 'extract_data:microdata');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('microdata'); }
    } catch { /* non-fatal */ }

    // Strategy 3: OpenGraph
    try {
      const r = await withTimeout(page.evaluate(buildOpenGraphExtractor(fieldNames)) as Promise<Record<string, unknown>>, budget.openGraphTimeoutMs, 'extract_data:opengraph');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('opengraph'); }
    } catch { /* non-fatal */ }

    if (countFields(merged) >= fieldNames.length) {
      const { result, validation } = validateAndCoerce(merged, schema);
      return buildResponseWithMode(result, validation.errors, pageUrl, strategies, domain, fieldNames, extractionMode, outputMode, inlineLimit, readiness);
    }

    // Strategy 4: CSS heuristic
    try {
      const r = await withTimeout(page.evaluate(buildCssHeuristicExtractor(fieldNames, schemaProps, selector)) as Promise<Record<string, unknown>>, budget.cssTimeoutMs, 'extract_data:css');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('css-heuristic'); }
    } catch { /* non-fatal */ }

    if (extractionMode === 'standard' && countFields(merged) < fieldNames.length) {
      try {
        const r = await withTimeout(
          page.evaluate(buildStandardDomExtractor(fieldNames, schemaProps, selector, budget.maxStandardDomNodes)) as Promise<Record<string, unknown>>,
          budget.standardDomTimeoutMs,
          'extract_data:standard-dom'
        );
        if (r && typeof r === 'object') {
          merged = mergeResults(merged, r);
          if (countFields(r) > 0) strategies.push('standard-dom');
        }
      } catch { /* non-fatal */ }
    }

    const { result, validation } = validateAndCoerce(merged, schema);
    return buildResponseWithMode(result, validation.errors, pageUrl, strategies, domain, fieldNames, extractionMode, outputMode, inlineLimit, readiness);
  } catch (error) {
    return { content: [{ type: 'text', text: `Extraction error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
};

function buildResponse(
  data: Record<string, unknown>, errors: string[], url: string,
  strategies: string[], domain: string, fieldNames: string[], extractionMode: ExtractionMode,
): { inlineResult: MCPResult; payload: Record<string, unknown> } {
  const fieldsFound = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k]) => k);
  const fieldsMissing = fieldNames.filter(f => !fieldsFound.includes(f));

  if (fieldsFound.length > 0) {
    const dm = getDomainMemory();
    dm.record(domain, `extract:single:${fieldNames.sort().join(',')}`, JSON.stringify({
      strategies, fieldsFound: fieldsFound.length, fieldsTotal: fieldNames.length,
    }));
  }

  const payload: Record<string, unknown> = {
    action: 'extract_data', url, data, fieldsFound: fieldsFound.length, fieldsTotal: fieldNames.length, strategies,
    modeUsed: extractionMode,
  };
  if (fieldsMissing.length > 0) payload.fieldsMissing = fieldsMissing;
  if (errors.length > 0) payload.validationErrors = errors;
  if (fieldsFound.length === 0) {
    payload.message = 'No data extracted. Try: (1) read_page to verify content, (2) provide a CSS selector, (3) wait_for before extracting.';
  }

  const textWithoutMetrics = JSON.stringify(payload);
  payload.metrics = { mode: extractionMode, outputChars: textWithoutMetrics.length };
  return { inlineResult: { content: [{ type: 'text', text: JSON.stringify(payload) }] }, payload };
}


async function buildResponseWithMode(
  data: Record<string, unknown>, errors: string[], url: string,
  strategies: string[], domain: string, fieldNames: string[],
  extractionMode: ExtractionMode, outputMode: import('./_shared/output-mode').OutputMode, inlineLimit: number,
  readiness?: Awaited<ReturnType<typeof waitForPageReady>>,
): Promise<MCPResult> {
  const { inlineResult, payload } = buildResponse(data, errors, url, strategies, domain, fieldNames, extractionMode);
  if (readiness) {
    payload.readiness = readiness;
    if (inlineResult.content?.[0]?.type === 'text') {
      inlineResult.content[0].text = JSON.stringify(payload);
    }
  }
  return resolveOutputMode(outputMode, inlineLimit, inlineResult, payload, 'extract_data');
}

export const extractDataHandler = handler;

export function registerExtractDataTool(server: MCPServer): void {
  server.registerTool('extract_data', handler, definition);
}
