/**
 * Extract Data Tool — Structured extraction API (#571)
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { waitForPageReady } from '../utils/page-ready-state';
import { formatStaleRefError, getRefIdManager } from '../utils/ref-id-manager';
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
    'Extract structured data with a JSON Schema from JSON-LD, Microdata, OpenGraph, or CSS. Use multiple:true for listings; use mode="semantic" plus query for bounded host-side semantic chunks; use exactly one of selector, ref_id, or backendNodeId to scope a page region.\n\nWhen to use: Typed products, articles, prices, or semantic facts into a schema.\nWhen NOT to use: Use read_page for raw content or javascript_tool for ad-hoc scraping.',
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
      ref_id: {
        type: 'string',
        description: 'Element ref_id from read_page or oc_observe to scope extraction region',
      },
      backendNodeId: {
        type: 'number',
        description: 'Chrome backend DOM node id to scope extraction region',
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

type ExtractionScope =
  | { type: 'document'; resolved: true }
  | { type: 'selector'; resolved: true; selector: string }
  | { type: 'ref_id'; resolved: true; ref_id: string; backendNodeId: number; frameId?: string }
  | { type: 'backendNodeId'; resolved: true; backendNodeId: number };

function parseBackendNodeId(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    return undefined;
  }
  return value;
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function createBackendNodeScopeSelector(
  page: Awaited<ReturnType<ReturnType<typeof getSessionManager>['getPage']>>,
  cdpClient: ReturnType<ReturnType<typeof getSessionManager>['getCDPClient']>,
  backendNodeId: number,
): Promise<string | undefined> {
  if (!page) return undefined;
  const token = `oc-extract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const { object } = await cdpClient.send<{ object?: { objectId?: string } }>(
    page,
    'DOM.resolveNode',
    { backendNodeId },
  );
  if (!object?.objectId) return undefined;

  const { result } = await cdpClient.send<{ result?: { value?: boolean } }>(
    page,
    'Runtime.callFunctionOn',
    {
      objectId: object.objectId,
      functionDeclaration: `function(token) {
        if (!(this instanceof Element)) return false;
        this.setAttribute('data-openchrome-extract-scope', token);
        return true;
      }`,
      arguments: [{ value: token }],
      returnByValue: true,
    },
  );

  return result?.value ? `[data-openchrome-extract-scope="${escapeCssAttributeValue(token)}"]` : undefined;
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
  const refId = args.ref_id as string | undefined;
  const backendNodeIdArg = args.backendNodeId;
  const multiple = (args.multiple as boolean) ?? false;
  const { mode: outputMode, inlineLimit } = parseOutputMode(args);
  const waitForReady = args.waitForReady === true;
  const readyTimeoutMs = typeof args.readyTimeoutMs === 'number' ? args.readyTimeoutMs : undefined;

  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error: tabId is required' }], isError: true };
  }

  const scopeArgumentCount = [selector, refId, backendNodeIdArg].filter(v => v !== undefined && v !== null && v !== '').length;
  if (scopeArgumentCount > 1) {
    return { content: [{ type: 'text', text: 'Error: provide exactly one of selector, ref_id, backendNodeId' }], isError: true };
  }

  if (backendNodeIdArg !== undefined && parseBackendNodeId(backendNodeIdArg) === undefined) {
    return { content: [{ type: 'text', text: 'Error: backendNodeId must be a positive safe integer' }], isError: true };
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

    let scopeSelector = selector;
    let scope: ExtractionScope = selector
      ? { type: 'selector', resolved: true, selector }
      : { type: 'document', resolved: true };

    if (refId) {
      const refIdManager = getRefIdManager();
      if (refIdManager.isRefStale(sessionId, tabId, refId)) {
        return {
          content: [{ type: 'text', text: `Error: ${formatStaleRefError(refId)}; alternatively call oc_observe to get fresh refs.` }],
          isError: true,
        };
      }
      const refEntry = typeof refIdManager.getRef === 'function' ? refIdManager.getRef(sessionId, tabId, refId) : undefined;
      const backendNodeId = refEntry?.backendDOMNodeId ?? refIdManager.resolveToBackendNodeId(sessionId, tabId, refId);
      if (!backendNodeId) {
        return {
          content: [{ type: 'text', text: `Error: ${formatStaleRefError(refId)}; alternatively call oc_observe to get fresh refs.` }],
          isError: true,
        };
      }
      try {
        const selectorFromRef = await createBackendNodeScopeSelector(page, sessionManager.getCDPClient(), backendNodeId);
        if (!selectorFromRef) throw new Error('CDP did not return a resolvable Element');
        scopeSelector = selectorFromRef;
        scope = { type: 'ref_id', resolved: true, ref_id: refId, backendNodeId, ...(refEntry?.frameId ? { frameId: refEntry.frameId } : {}) };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: Could not resolve ref_id ${refId} for scoped extraction. ${formatStaleRefError(refId)}; call read_page or oc_observe for fresh refs. ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    } else if (backendNodeIdArg !== undefined) {
      const backendNodeId = parseBackendNodeId(backendNodeIdArg);
      if (!backendNodeId) {
        return { content: [{ type: 'text', text: 'Error: backendNodeId must be a positive safe integer' }], isError: true };
      }
      try {
        const selectorFromBackendNode = await createBackendNodeScopeSelector(page, sessionManager.getCDPClient(), backendNodeId);
        if (!selectorFromBackendNode) throw new Error('CDP did not return a resolvable Element');
        scopeSelector = selectorFromBackendNode;
        scope = { type: 'backendNodeId', resolved: true, backendNodeId };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: Could not resolve backendNodeId ${backendNodeId} for scoped extraction. Call read_page or oc_observe to get fresh refs. ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }

    const hasElementScope = scope.type !== 'document';

    if (extractionMode === 'semantic') {
      if (!query || query.trim().length === 0) {
        return { content: [{ type: 'text', text: 'Error: mode="semantic" requires a non-empty query' }], isError: true };
      }
      if (multiple) {
        return { content: [{ type: 'text', text: 'Error: mode="semantic" does not support multiple=true; use continuation metadata and alreadyCollected instead.' }], isError: true };
      }
      const includeLinks = args.includeLinks !== false;
      const html = scopeSelector
        ? await withTimeout(page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          return el ? (el as HTMLElement).outerHTML : '';
        }, scopeSelector) as Promise<string>, 15000, 'extract_data:semantic.selector', _context)
        : await withTimeout(page.content(), 15000, 'extract_data:semantic.content', _context);
      if (!html) {
        return { content: [{ type: 'text', text: `Error: scope "${selector ?? refId ?? backendNodeIdArg ?? 'document'}" did not match content for semantic extraction` }], isError: true };
      }
      const { html: cleaned } = extractMainContent(html, { onlyMainContent: !scopeSelector });
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
        scope,
        selector: scopeSelector || undefined,
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
      const multiScript = buildMultipleItemExtractor(fieldNames, schemaProps, scopeSelector);
      const rawItems = await withTimeout(page.evaluate(multiScript) as Promise<Record<string, unknown>[]>, 15000, 'extract_data');

      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            action: 'extract_data', url: pageUrl, multiple: true, items: [], count: 0, scope,
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
        action: 'extract_data', url: pageUrl, multiple: true, items: validated, count: validated.length, scope,
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
    if (!hasElementScope) try {
      const r = await withTimeout(page.evaluate(buildJsonLdExtractor(fieldNames)) as Promise<Record<string, unknown>>, budget.jsonLdTimeoutMs, 'extract_data:jsonld');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('json-ld'); }
    } catch { /* non-fatal */ }

    if (countFields(merged) >= fieldNames.length) {
      const { result, validation } = validateAndCoerce(merged, schema);
      return buildResponseWithMode(result, validation.errors, pageUrl, strategies, domain, fieldNames, extractionMode, outputMode, inlineLimit, readiness, scope);
    }

    // Strategy 2: Microdata
    if (!hasElementScope) try {
      const r = await withTimeout(page.evaluate(buildMicrodataExtractor(fieldNames)) as Promise<Record<string, unknown>>, budget.microdataTimeoutMs, 'extract_data:microdata');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('microdata'); }
    } catch { /* non-fatal */ }

    // Strategy 3: OpenGraph
    if (!hasElementScope) try {
      const r = await withTimeout(page.evaluate(buildOpenGraphExtractor(fieldNames)) as Promise<Record<string, unknown>>, budget.openGraphTimeoutMs, 'extract_data:opengraph');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('opengraph'); }
    } catch { /* non-fatal */ }

    if (countFields(merged) >= fieldNames.length) {
      const { result, validation } = validateAndCoerce(merged, schema);
      return buildResponseWithMode(result, validation.errors, pageUrl, strategies, domain, fieldNames, extractionMode, outputMode, inlineLimit, readiness, scope);
    }

    // Strategy 4: CSS heuristic
    try {
      const r = await withTimeout(page.evaluate(buildCssHeuristicExtractor(fieldNames, schemaProps, scopeSelector)) as Promise<Record<string, unknown>>, budget.cssTimeoutMs, 'extract_data:css');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('css-heuristic'); }
    } catch { /* non-fatal */ }

    if (extractionMode === 'standard' && countFields(merged) < fieldNames.length) {
      try {
        const r = await withTimeout(
          page.evaluate(buildStandardDomExtractor(fieldNames, schemaProps, scopeSelector, budget.maxStandardDomNodes)) as Promise<Record<string, unknown>>,
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
    return buildResponseWithMode(result, validation.errors, pageUrl, strategies, domain, fieldNames, extractionMode, outputMode, inlineLimit, readiness, scope);
  } catch (error) {
    return { content: [{ type: 'text', text: `Extraction error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
};

function buildResponse(
  data: Record<string, unknown>, errors: string[], url: string,
  strategies: string[], domain: string, fieldNames: string[], extractionMode: ExtractionMode,
  scope?: ExtractionScope,
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
    ...(scope ? { scope } : {}),
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
  scope?: ExtractionScope,
): Promise<MCPResult> {
  const { inlineResult, payload } = buildResponse(data, errors, url, strategies, domain, fieldNames, extractionMode, scope);
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
