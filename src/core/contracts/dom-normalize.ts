/** DOM normalization and deterministic tree diff helpers for oc_diff (#832). */

const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const GENERATED_ID_RE = /(?:r:\w+|:r\d+:|v-[a-zA-Z0-9]{8})/g;
const TOKEN_ATTR_RE = /^(?:data-nonce|data-rid)$/i;

export interface NormalizedDomNode {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  children: NormalizedDomNode[];
}

export interface DomDiffEntry {
  op: 'add' | 'remove' | 'modify';
  path: string;
}

export interface DomDiffSummary {
  added: number;
  removed: number;
  modified: number;
  entries: DomDiffEntry[];
}

export function normalizeDomInput(input: unknown): NormalizedDomNode | null {
  const html = extractHtml(input);
  if (!html) return null;
  return parseHtml(html);
}

export function diffDom(before: NormalizedDomNode | null, after: NormalizedDomNode | null): DomDiffSummary {
  const entries: DomDiffEntry[] = [];
  walkDiff(before, after, '', entries);
  return {
    added: entries.filter((entry) => entry.op === 'add').length,
    removed: entries.filter((entry) => entry.op === 'remove').length,
    modified: entries.filter((entry) => entry.op === 'modify').length,
    entries,
  };
}

function extractHtml(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.html === 'string') return obj.html;
  if (typeof obj.dom === 'string') return obj.dom;
  return JSON.stringify(obj);
}

function normalizeText(value: string): string {
  return value.replace(ISO_TS_RE, '<TS>').replace(GENERATED_ID_RE, '<GEN>').replace(/\s+/g, ' ').trim();
}

function normalizeAttr(name: string, value: string): string {
  if (/^csrf/i.test(name) || TOKEN_ATTR_RE.test(name)) return '<TOKEN>';
  let out = normalizeText(value);
  if (name.toLowerCase() === 'class') out = out.split(/\s+/).filter(Boolean).sort().join(' ');
  return out;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:@A-Za-z0-9_-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    attrs[name] = normalizeAttr(name, match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

function parseHtml(html: string): NormalizedDomNode {
  const root: NormalizedDomNode = { tag: 'root', attrs: {}, children: [] };
  const stack: NormalizedDomNode[] = [root];
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const tagMatch = token.match(/^<\s*([A-Za-z0-9_-]+)([^>]*)>/);
      if (!tagMatch) continue;
      const tag = tagMatch[1].toLowerCase();
      const node: NormalizedDomNode = { tag, attrs: parseAttrs(tagMatch[2] || ''), children: [] };
      stack[stack.length - 1].children.push(node);
      const selfClosing = /\/\s*>$/.test(token) || ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'].includes(tag);
      if (!selfClosing) stack.push(node);
      continue;
    }
    const parent = stack[stack.length - 1];
    if (parent.tag === 'script' || parent.tag === 'style') continue;
    const text = normalizeText(token);
    if (text) parent.text = parent.text ? `${parent.text} ${text}` : text;
  }
  return root;
}

function nodeSignature(node: NormalizedDomNode | null): string {
  if (!node) return '';
  return JSON.stringify({ tag: node.tag, attrs: node.attrs, text: node.text ?? '' });
}

function indexedPath(parentPath: string, siblings: NormalizedDomNode[], index: number): string {
  const node = siblings[index];
  const sameTagBefore = siblings.slice(0, index + 1).filter((candidate) => candidate.tag === node.tag).length;
  return `${parentPath}/${node.tag}[${sameTagBefore}]`;
}

function walkDiff(before: NormalizedDomNode | null, after: NormalizedDomNode | null, path: string, entries: DomDiffEntry[]): void {
  if (!before && !after) return;
  if (!before) { entries.push({ op: 'add', path }); return; }
  if (!after) { entries.push({ op: 'remove', path }); return; }
  if (before.tag !== after.tag) { entries.push({ op: 'modify', path }); return; }
  if (before.tag !== 'root' && nodeSignature(before) !== nodeSignature(after)) entries.push({ op: 'modify', path });
  const max = Math.max(before.children.length, after.children.length);
  for (let i = 0; i < max; i++) {
    const childPath = before.children[i] ? indexedPath(path, before.children, i) : after.children[i] ? indexedPath(path, after.children, i) : path;
    walkDiff(before.children[i] ?? null, after.children[i] ?? null, childPath, entries);
  }
}
