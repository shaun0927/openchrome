/**
 * Extract Data Tool — Structured extraction API (#571)
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { getDomainMemory, extractDomainFromUrl } from '../memory/domain-memory';
import {
  validateSchema,
  validateAndCoerce,
  buildJsonLdExtractor,
  buildMicrodataExtractor,
  buildOpenGraphExtractor,
  buildCssHeuristicExtractor,
  buildMultipleItemExtractor,
  buildStandardDomExtractor,
  EXTRACTION_MODE_BUDGETS,
  parseExtractionMode,
} from '../extraction';
import type { ExtractionMode, ExtractionSchema, SchemaProperty } from '../extraction';

const definition: MCPToolDefinition = {
  name: 'extract_data',
  description:
    'Extract structured data from page using a JSON Schema. Tries JSON-LD, Microdata, OpenGraph, and CSS heuristics. Use multiple:true for listings.\n\nWhen to use: Extracting typed structured data (products, articles, prices) from a page into a schema.\nWhen NOT to use: Use javascript_tool for ad-hoc extraction, or read_page to read raw page content.',
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
      selector: {
        type: 'string',
        description: 'CSS selector to scope extraction region',
      },
      multiple: {
        type: 'boolean',
        description: 'Extract array of items (for listings/tables). Default: false',
      },
      mode: {
        type: 'string',
        enum: ['fast', 'standard'],
        description: 'Extraction budget mode. fast is the default/current bounded strategy set; standard adds a broader bounded DOM pass.',
      },
    },
    required: ['tabId', 'schema'],
  },
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

export const extractDataHandler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  _context?: ToolContext
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const schema = args.schema as ExtractionSchema;
  const selector = args.selector as string | undefined;
  const multiple = (args.multiple as boolean) ?? false;
  const modeCheck = parseExtractionMode(args.mode);

  if (!modeCheck.ok) {
    return { content: [{ type: 'text', text: `Error: ${modeCheck.error}` }], isError: true };
  }
  const mode = modeCheck.mode;
  const budget = EXTRACTION_MODE_BUDGETS[mode];

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

    const pageUrl = page.url();
    const domain = extractDomainFromUrl(pageUrl);

    const startedAt = Date.now();

    // Multiple items mode
    if (multiple) {
      const multiScript = buildMultipleItemExtractor(fieldNames, schemaProps, selector);
      const rawItems = await withTimeout(page.evaluate(multiScript) as Promise<Record<string, unknown>[]>, mode === 'standard' ? budget.standardDomTimeoutMs : budget.cssTimeoutMs, 'extract_data');

      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            action: 'extract_data', url: pageUrl, multiple: true, modeUsed: mode, items: [], count: 0,
            metrics: buildMetrics({}, fieldNames, startedAt, mode),
            message: mode === 'fast'
              ? 'No repeating items found. Try a more specific selector or retry with mode: "standard" if the list is rendered in a broader container.'
              : 'No repeating items found. Try a more specific selector or check if the page has loaded.',
          }) }],
        };
      }

      const itemSchema: ExtractionSchema = { type: 'object', properties: schemaProps, required: schema.items?.required || [] };
      const validated = rawItems.map(raw => validateAndCoerce(raw, itemSchema).result);

      const domainMemory = getDomainMemory();
      domainMemory.record(domain, `extract:multiple:${fieldNames.sort().join(',')}`, JSON.stringify({
        selector: selector || 'auto', fieldCount: fieldNames.length, itemCount: validated.length,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          action: 'extract_data', url: pageUrl, multiple: true, modeUsed: mode, items: validated, count: validated.length,
          metrics: buildMetrics(validated[0] || {}, fieldNames, startedAt, mode),
        }) }],
      };
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
      return buildResponse(result, validation.errors, pageUrl, strategies, domain, fieldNames, mode, startedAt);
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
      return buildResponse(result, validation.errors, pageUrl, strategies, domain, fieldNames, mode, startedAt);
    }

    // Strategy 4: CSS heuristic
    try {
      const r = await withTimeout(page.evaluate(buildCssHeuristicExtractor(fieldNames, schemaProps, selector)) as Promise<Record<string, unknown>>, budget.cssTimeoutMs, 'extract_data:css');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('css-heuristic'); }
    } catch { /* non-fatal */ }

    if (mode === 'standard' && countFields(merged) < fieldNames.length) {
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
    return buildResponse(result, validation.errors, pageUrl, strategies, domain, fieldNames, mode, startedAt);
  } catch (error) {
    return { content: [{ type: 'text', text: `Extraction error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
};

function buildResponse(
  data: Record<string, unknown>, errors: string[], url: string,
  strategies: string[], domain: string, fieldNames: string[], mode: ExtractionMode, startedAt: number
): MCPResult {
  const fieldsFound = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k]) => k);
  const fieldsMissing = fieldNames.filter(f => !fieldsFound.includes(f));

  if (fieldsFound.length > 0) {
    const dm = getDomainMemory();
    dm.record(domain, `extract:single:${fieldNames.sort().join(',')}`, JSON.stringify({
      strategies, fieldsFound: fieldsFound.length, fieldsTotal: fieldNames.length,
    }));
  }

  const response: Record<string, unknown> = {
    action: 'extract_data', url, modeUsed: mode, data, fieldsFound: fieldsFound.length, fieldsTotal: fieldNames.length, strategies,
    metrics: buildMetrics(data, fieldNames, startedAt, mode),
  };
  if (fieldsMissing.length > 0) response.fieldsMissing = fieldsMissing;
  if (errors.length > 0) response.validationErrors = errors;
  if (fieldsFound.length === 0) {
    response.message = mode === 'fast'
      ? 'No data extracted. Try: (1) read_page to verify content, (2) provide a CSS selector, (3) wait_for before extracting, (4) retry with mode: "standard" when visible DOM context is needed.'
      : 'No data extracted. Try: (1) read_page to verify content, (2) provide a CSS selector, (3) wait_for before extracting.';
  }

  return { content: [{ type: 'text', text: JSON.stringify(response) }] };
}

function buildMetrics(data: Record<string, unknown>, fieldNames: string[], startedAt: number, mode: ExtractionMode): Record<string, unknown> {
  const fieldsFound = Object.values(data).filter(v => v !== null && v !== undefined && v !== '').length;
  const outputChars = JSON.stringify(data).length;
  const budget = EXTRACTION_MODE_BUDGETS[mode];
  return {
    mode,
    durationMs: Math.max(0, Date.now() - startedAt),
    outputChars,
    fieldsFound,
    fieldsTotal: fieldNames.length,
    budget: {
      maxCssNodes: budget.maxCssNodes,
      maxStandardDomNodes: budget.maxStandardDomNodes,
      cssTimeoutMs: budget.cssTimeoutMs,
      standardDomTimeoutMs: budget.standardDomTimeoutMs,
    },
  };
}

export function registerExtractDataTool(server: MCPServer): void {
  server.registerTool('extract_data', extractDataHandler, definition);
}
