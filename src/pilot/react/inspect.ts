export interface ReactTreeNode {
  ref: string;
  name: string;
  key: string | null;
  depth: number;
  childCount: number;
}

export interface ReactSnapshot {
  available: boolean;
  reason?: string;
  tree: ReactTreeNode[];
}

export function summarizeFiberTree(root: unknown, limit = 200): ReactSnapshot {
  if (!root || typeof root !== 'object') return { available: false, reason: 'no-react-hook', tree: [] };
  const current = (root as { current?: unknown }).current ?? root;
  const tree: ReactTreeNode[] = [];
  let seq = 0;
  const seen = new Set<unknown>();
  function visit(fiber: unknown, depth: number): void {
    if (!fiber || typeof fiber !== 'object' || seen.has(fiber) || tree.length >= limit) return;
    seen.add(fiber);
    const f = fiber as { type?: { displayName?: string; name?: string } | string; elementType?: { displayName?: string; name?: string }; key?: string | null; child?: unknown; sibling?: unknown };
    const name = typeof f.type === 'string'
      ? f.type
      : f.type?.displayName || f.type?.name || f.elementType?.displayName || f.elementType?.name || 'Anonymous';
    let childCount = 0;
    let child = f.child;
    while (child && typeof child === 'object') {
      childCount++;
      child = (child as { sibling?: unknown }).sibling;
    }
    tree.push({ ref: `@e${++seq}`, name, key: f.key ?? null, depth, childCount });
    child = f.child;
    while (child && typeof child === 'object') {
      visit(child, depth + 1);
      child = (child as { sibling?: unknown }).sibling;
    }
  }
  visit(current, 0);
  return tree.length > 0 ? { available: true, tree } : { available: false, reason: 'empty-react-tree', tree: [] };
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSensitive(v, depth + 1));
  if (typeof value === 'string') {
    return value
      .replace(/(password|token|secret|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .slice(0, 500);
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (/password|token|secret|credential|api[_-]?key/i.test(k)) out[k] = '[REDACTED]';
    else out[k] = redactSensitive(v, depth + 1);
  }
  return out;
}
