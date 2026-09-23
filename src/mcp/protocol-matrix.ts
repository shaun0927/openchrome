/**
 * Which JSON-RPC methods each MCP protocol era serves. This is the single
 * source for the support matrix in docs/mcp-2026-07-28.md; a test keeps the
 * document's JSON block identical to this table.
 *
 * `legacy` covers initialize-based clients (stdio negotiated by the SDK,
 * HTTP pinned to 2024-11-05); `modern` covers stateless 2026-07-28 requests.
 */
export type EraSupport = 'served' | 'rejected' | 'replaced';

export interface MethodSupport {
  legacy: EraSupport;
  modern: EraSupport;
  /** Modern replacement or behavior note when not simply served. */
  note?: string;
}

export const METHOD_SUPPORT: Readonly<Record<string, MethodSupport>> = Object.freeze({
  'initialize': { legacy: 'served', modern: 'rejected', note: 'modern clients use server/discover; initialize selects legacy semantics' },
  'notifications/initialized': { legacy: 'served', modern: 'rejected' },
  'server/discover': { legacy: 'rejected', modern: 'served' },
  'ping': { legacy: 'served', modern: 'rejected', note: 'removed in 2026-07-28' },
  'tools/list': { legacy: 'served', modern: 'served', note: 'modern returns the full capability- and scope-filtered registry with cache hints' },
  'tools/call': { legacy: 'served', modern: 'served' },
  'resources/list': { legacy: 'served', modern: 'served' },
  'resources/templates/list': { legacy: 'served', modern: 'served' },
  'resources/read': { legacy: 'served', modern: 'served' },
  'resources/subscribe': { legacy: 'served', modern: 'replaced', note: 'subscriptions/listen' },
  'resources/unsubscribe': { legacy: 'served', modern: 'replaced', note: 'subscriptions/listen' },
  'subscriptions/listen': { legacy: 'rejected', modern: 'served' },
  'logging/setLevel': { legacy: 'served', modern: 'replaced', note: 'per-request io.modelcontextprotocol/logLevel' },
  'notifications/roots/list_changed': { legacy: 'served', modern: 'rejected', note: 'modern roots are requested per call' },
  'notifications/cancelled': { legacy: 'served', modern: 'served', note: 'HTTP modern: closing the response stream cancels' },
  'sessions/list': { legacy: 'served', modern: 'served', note: 'OpenChrome extension method' },
  'sessions/create': { legacy: 'served', modern: 'served', note: 'OpenChrome extension method' },
  'sessions/delete': { legacy: 'served', modern: 'served', note: 'OpenChrome extension method' },
  'sampling/createMessage': { legacy: 'served', modern: 'replaced', note: 'server->client request; modern uses input_required' },
  'elicitation/create': { legacy: 'served', modern: 'replaced', note: 'server->client request; modern uses input_required' },
  'roots/list': { legacy: 'served', modern: 'replaced', note: 'server->client request; modern uses input_required' },
});
