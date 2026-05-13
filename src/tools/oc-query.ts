/**
 * oc_query — provider-neutral semantic element resolution for interaction workflows.
 *
 * This is a deterministic local query layer over existing OpenChrome AX/DOM
 * resolution primitives. It does not call external AgentQL/LLM services.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { discoverElements, cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';
import { FoundElement, normalizeQuery, scoreElement, tokenizeQuery } from '../utils/element-finder';
import { resolveElementsByAXTree } from '../utils/ax-element-resolver';

export interface OcQueryResult {
  path: string;
  ref: string;
  source: 'ax' | 'dom';
  role: string;
  name: string;
  score: number;
  tagName?: string;
  text?: string;
  backendDOMNodeId?: number;
  rect?: { x: number; y: number; width: number; height: number };
  useWith: string[];
}

export interface OcQueryResponse {
  query: string;
  purpose: 'interaction' | 'extraction' | 'verification';
  count: number;
  results: OcQueryResult[];
  nextAction: string;
}

const definition: MCPToolDefinition = {
  name: 'oc_query',
  description:
    'Resolve a semantic element query into stable refs for interaction workflows. ' +
    'Uses local AX/DOM matching only; no external AgentQL or LLM provider is called. ' +
    'Pass returned refs to interact, act, fill_form, read_page(ref_id), or plan parseResult.storeAs paths.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'REQUIRED Tab id to query.' },
      query: { type: 'string', description: 'REQUIRED Semantic query such as "checkout button" or "email field".' },
      purpose: { type: 'string', enum: ['interaction', 'extraction', 'verification'], description: 'How the caller intends to use the result. Default: interaction.' },
      limit: { type: 'number', description: 'Maximum refs to return. Default 5, max 20.' },
      includeCandidates: { type: 'boolean', description: 'When true, include lower-scored DOM candidates as well as AX matches. Default true.' },
    },
    required: ['tabId', 'query'],
  },
  annotations: TOOL_ANNOTATIONS.oc_query,
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const tabId = String(args.tabId || '');
  const query = String(args.query || '').trim();
  const purpose = normalizePurpose(args.purpose);
  const limit = clampLimit(args.limit);
  const includeCandidates = args.includeCandidates !== false;

  if (!tabId) return errorResult('tabId is required');
  if (!query) return errorResult('query is required');
  if (context && !hasBudget(context, 8_000)) {
    return errorResult('oc_query: deadline approaching — skipped semantic query resolution');
  }

  try {
    const sessionManager = getSessionManager();
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'oc_query');
    if (!page) {
      return errorResult(`Tab ${tabId} not found or no longer available`);
    }

    const cdpClient = sessionManager.getCDPClient();
    const refIdManager = getRefIdManager();
    const results: OcQueryResult[] = [];

    try {
      const axMatches = await resolveElementsByAXTree(page, cdpClient, query, {
        useCenter: false,
        maxResults: limit,
      });
      for (const match of axMatches) {
        const ref = refIdManager.generateRef(
          sessionId,
          tabId,
          match.backendDOMNodeId,
          match.role,
          match.name,
        );
        results.push({
          path: `results.${results.length}`,
          ref,
          source: 'ax',
          role: match.role,
          name: match.name,
          score: axScore(match.matchLevel),
          backendDOMNodeId: match.backendDOMNodeId,
          rect: match.rect,
          useWith: recommendedTools(purpose),
        });
      }
    } catch {
      // AX lookup is best-effort; DOM discovery below is the deterministic fallback.
    }

    if (includeCandidates && results.length < limit) {
      const queryLower = normalizeQuery(query);
      const queryTokens = tokenizeQuery(query);
      const domMatches = await discoverElements(page, cdpClient, queryLower, {
        maxResults: Math.max(limit * 2, 10),
        useCenter: false,
        timeout: 10_000,
        toolName: 'oc_query',
      });
      const existingBackendIds = new Set(results.map(r => r.backendDOMNodeId).filter((id): id is number => typeof id === 'number'));
      const scored = domMatches
        .filter(match => match.backendDOMNodeId > 0 && !existingBackendIds.has(match.backendDOMNodeId))
        .map(match => ({ ...match, score: scoreElement(match as FoundElement, queryLower, queryTokens) }))
        .filter(match => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit - results.length);

      for (const match of scored) {
        const ref = refIdManager.generateRef(
          sessionId,
          tabId,
          match.backendDOMNodeId,
          match.role,
          match.name,
          match.tagName,
          match.textContent,
        );
        results.push({
          path: `results.${results.length}`,
          ref,
          source: 'dom',
          role: match.role,
          name: match.name,
          tagName: match.tagName,
          text: match.textContent,
          score: match.score,
          backendDOMNodeId: match.backendDOMNodeId,
          rect: match.rect,
          useWith: recommendedTools(purpose),
        });
      }
    }

    await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

    const response = buildResponse(query, purpose, results);
    return {
      structuredContent: response as unknown as Record<string, unknown>,
      content: [{ type: 'text', text: formatResponse(response) }],
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
};

export function buildResponse(query: string, purpose: OcQueryResponse['purpose'], results: OcQueryResult[]): OcQueryResponse {
  return {
    query,
    purpose,
    count: results.length,
    results,
    nextAction: results.length > 0
      ? `Use ${results[0].path}.ref (${results[0].ref}) with ${recommendedTools(purpose).join(' or ')}.`
      : 'No semantic matches found. Try a more specific query, read_page(mode="ax"), or query_dom with a known selector.',
  };
}

export function formatResponse(response: OcQueryResponse): string {
  const lines = [`oc_query: ${response.count} result(s) for "${response.query}"`, `Purpose: ${response.purpose}`];
  for (const result of response.results) {
    const label = result.name ? ` "${result.name}"` : '';
    const tag = result.tagName ? ` <${result.tagName}>` : '';
    lines.push(`- ${result.path}.ref=${result.ref} [${result.source}] ${result.role}${tag}${label} score=${result.score}`);
  }
  lines.push(`Next: ${response.nextAction}`);
  return lines.join('\n');
}

function recommendedTools(purpose: OcQueryResponse['purpose']): string[] {
  if (purpose === 'extraction') return ['read_page(ref_id)', 'extract_data'];
  if (purpose === 'verification') return ['oc_assert', 'read_page(ref_id)'];
  return ['interact', 'act', 'fill_form'];
}

function normalizePurpose(value: unknown): OcQueryResponse['purpose'] {
  return value === 'extraction' || value === 'verification' ? value : 'interaction';
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 5;
  return Math.max(1, Math.min(20, n));
}

function axScore(matchLevel: number): number {
  return matchLevel === 1 ? 130 : matchLevel === 2 ? 100 : 80;
}

function errorResult(message: string): MCPResult {
  return {
    isError: true,
    structuredContent: { error: { code: 'oc_query_error', message } },
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

export function registerOcQueryTool(server: MCPServer): void {
  server.registerTool('oc_query', handler, definition);
}

export const ocQueryToolHandler = handler;
