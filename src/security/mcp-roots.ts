/**
 * MCP roots narrowing policy (#880).
 *
 * Roots are client-supplied constraints. OpenChrome treats them as additive
 * narrowing only: they can deny URLs/files otherwise allowed by static config,
 * but they never permit anything the static server policy would deny.
 *
 * This first slice enforces network roots for URL-egress tools. File roots and
 * retroactive in-flight cancellation remain outside this helper.
 */

export interface McpRootEntry {
  uri: string;
  name?: string;
}

export interface NetworkRoot {
  uri: string;
  protocol: 'https:';
  host: string;
  wildcardSubdomains: boolean;
}

export interface ParsedMcpRoots {
  raw: McpRootEntry[];
  network: NetworkRoot[];
}

const sessionRoots = new Map<string, ParsedMcpRoots>();

export function parseMcpRoots(value: unknown): ParsedMcpRoots {
  const rootsValue = Array.isArray((value as { roots?: unknown } | undefined)?.roots)
    ? (value as { roots: unknown[] }).roots
    : Array.isArray(value)
      ? value
      : [];

  const raw: McpRootEntry[] = [];
  const network: NetworkRoot[] = [];
  for (const item of rootsValue) {
    if (!item || typeof item !== 'object') continue;
    const uri = (item as { uri?: unknown }).uri;
    if (typeof uri !== 'string' || uri.length === 0) continue;
    const name = (item as { name?: unknown }).name;
    raw.push({ uri, ...(typeof name === 'string' ? { name } : {}) });
    const parsed = parseNetworkRoot(uri);
    if (parsed) network.push(parsed);
  }
  return { raw, network };
}

export function setSessionMcpRoots(sessionId: string, value: unknown): ParsedMcpRoots {
  const parsed = parseMcpRoots(value);
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    sessionRoots.set(sessionId, parsed);
  }
  return parsed;
}

export function getSessionMcpRoots(sessionId: string): ParsedMcpRoots | undefined {
  return sessionRoots.get(sessionId);
}

export function clearSessionMcpRoots(sessionId: string): void {
  sessionRoots.delete(sessionId);
}

export function clearAllSessionMcpRoots(): void {
  sessionRoots.clear();
}

export function assertUrlAllowedBySessionRoots(sessionId: string, url: string): void {
  const roots = getSessionMcpRoots(sessionId);
  if (!roots || roots.network.length === 0) return;
  const host = extractHttpsHost(url);
  if (!host) return;
  const allowed = roots.network.some((root) => hostMatchesNetworkRoot(host, root));
  if (!allowed) {
    throw new Error(
      `Access to URL host "${host}" is blocked by MCP roots narrowing for session "${sessionId}". ` +
      `Allowed network roots: ${roots.network.map((root) => root.uri).join(', ')}`,
    );
  }
}

export function isUrlAllowedBySessionRoots(sessionId: string, url: string): boolean {
  try {
    assertUrlAllowedBySessionRoots(sessionId, url);
    return true;
  } catch {
    return false;
  }
}

function parseNetworkRoot(uri: string): NetworkRoot | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase();
  if (!host) return null;
  const wildcardSubdomains = host.startsWith('*.');
  if (wildcardSubdomains) host = host.slice(2);
  if (!host || host.includes('*')) return null;
  return { uri, protocol: 'https:', host, wildcardSubdomains };
}

function extractHttpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    try {
      const parsed = new URL(`https://${url}`);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

function hostMatchesNetworkRoot(host: string, root: NetworkRoot): boolean {
  if (root.wildcardSubdomains) {
    return host.endsWith(`.${root.host}`) && host !== root.host;
  }
  return host === root.host;
}
