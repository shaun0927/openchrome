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
} from '../extraction';
import type { ExtractionSchema, SchemaProperty } from '../extraction';

const definition: MCPToolDefinition = {
  name: 'extract_data',
  description:
    'Extract structured data from page using a JSON Schema. ' +
    'Automatically tries JSON-LD, Microdata, OpenGraph, and CSS heuristics. ' +
    'Use multiple:true for listings (products, search results, articles).',
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

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  _context?: ToolContext
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const schema = args.schema as ExtractionSchema;
  const selector = args.selector as string | undefined;
  const multiple = (args.multiple as boolean) ?? false;

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
    const fieldNames = Object.keys(schemaProps);

    if (fieldNames.length === 0) {
      return { content: [{ type: 'text', text: 'Error: Schema must define at least one property' }], isError: true };
    }

    const pageUrl = page.url();
    const domain = extractDomainFromUrl(pageUrl);

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

      return {
        content: [{ type: 'text', text: JSON.stringify({
          action: 'extract_data', url: pageUrl, multiple: true, items: validated, count: validated.length,
        }) }],
      };
    }

    // Single item — layered strategies
    let merged: Record<string, unknown> = {};
    const strategies: string[] = [];

    // Strategy 1: JSON-LD
    try {
      const r = await withTimeout(page.evaluate(buildJsonLdExtractor(fieldNames)) as Promise<Record<string, unknown>>, 5000, 'extract_data:jsonld');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('json-ld'); }
    } catch { /* non-fatal */ }

    if (countFields(merged) >= fieldNames.length) {
      const { result, validation } = validateAndCoerce(merged, schema);
      return buildResponse(result, validation.errors, pageUrl, strategies, domain, fieldNames);
    }

    // Strategy 2: Microdata
    try {
      const r = await withTimeout(page.evaluate(buildMicrodataExtractor(fieldNames)) as Promise<Record<string, unknown>>, 5000, 'extract_data:microdata');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('microdata'); }
    } catch { /* non-fatal */ }

    // Strategy 3: OpenGraph
    try {
      const r = await withTimeout(page.evaluate(buildOpenGraphExtractor(fieldNames)) as Promise<Record<string, unknown>>, 5000, 'extract_data:opengraph');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('opengraph'); }
    } catch { /* non-fatal */ }

    if (countFields(merged) >= fieldNames.length) {
      const { result, validation } = validateAndCoerce(merged, schema);
      return buildResponse(result, validation.errors, pageUrl, strategies, domain, fieldNames);
    }

    // Strategy 4: CSS heuristic
    try {
      const r = await withTimeout(page.evaluate(buildCssHeuristicExtractor(fieldNames, schemaProps, selector)) as Promise<Record<string, unknown>>, 10000, 'extract_data:css');
      if (r && typeof r === 'object') { merged = mergeResults(merged, r); if (countFields(r) > 0) strategies.push('css-heuristic'); }
    } catch { /* non-fatal */ }

    const { result, validation } = validateAndCoerce(merged, schema);
    return buildResponse(result, validation.errors, pageUrl, strategies, domain, fieldNames);
  } catch (error) {
    return { content: [{ type: 'text', text: `Extraction error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
};

function buildResponse(
  data: Record<string, unknown>, errors: string[], url: string,
  strategies: string[], domain: string, fieldNames: string[]
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
    action: 'extract_data', url, data, fieldsFound: fieldsFound.length, fieldsTotal: fieldNames.length, strategies,
  };
  if (fieldsMissing.length > 0) response.fieldsMissing = fieldsMissing;
  if (errors.length > 0) response.validationErrors = errors;
  if (fieldsFound.length === 0) {
    response.message = 'No data extracted. Try: (1) read_page to verify content, (2) provide a CSS selector, (3) wait_for before extracting.';
  }

  return { content: [{ type: 'text', text: JSON.stringify(response) }] };
}

export function registerExtractDataTool(server: MCPServer): void {
  server.registerTool('extract_data', handler, definition);
}
