export type ContentFilterType = 'none' | 'prune' | 'bm25';

export interface ContentFilterOptions {
  type?: ContentFilterType;
  query?: string;
  returnRaw?: boolean;
  returnFit?: boolean;
  minWords?: number;
  maxSections?: number;
  bm25Threshold?: number;
  pruneThreshold?: number;
}

export interface ContentFilterMetrics {
  type: ContentFilterType;
  raw_chars: number;
  fit_chars: number;
  reduction_ratio: number;
  sections_seen: number;
  sections_kept: number;
  query?: string;
}

export interface ContentFilterResult {
  content: string;
  raw_markdown?: string;
  fit_markdown?: string;
  filter: ContentFilterMetrics;
}

interface Section {
  index: number;
  text: string;
  headingDepth: number;
  words: number;
  score: number;
}

export function parseContentFilterType(value: unknown): ContentFilterType {
  return value === 'prune' || value === 'bm25' ? value : 'none';
}

export function applyContentFilter(markdown: string, options: ContentFilterOptions = {}): ContentFilterResult {
  const type = options.type ?? 'none';
  const sections = splitSections(markdown);
  const maxSections = clampInt(options.maxSections, 80, 1, 500);
  const minWords = clampInt(options.minWords, 5, 0, 100);
  const query = (options.query || '').trim();

  if (type === 'bm25' && !query) {
    throw new Error('content_filter="bm25" requires a non-empty query');
  }

  const kept = type === 'none'
    ? sections
    : rankSections(sections, { type, query, minWords, maxSections, bm25Threshold: options.bm25Threshold, pruneThreshold: options.pruneThreshold });
  const fit = kept.map(section => section.text.trim()).filter(Boolean).join('\n\n').trim();
  const content = type !== 'none' && options.returnFit !== false ? fit : markdown;
  const metrics: ContentFilterMetrics = {
    type,
    raw_chars: markdown.length,
    fit_chars: fit.length,
    reduction_ratio: markdown.length > 0 ? roundRatio(1 - fit.length / markdown.length) : 0,
    sections_seen: sections.length,
    sections_kept: kept.length,
    ...(query ? { query } : {}),
  };

  return {
    content,
    ...(options.returnRaw ? { raw_markdown: markdown } : {}),
    ...(type !== 'none' && options.returnFit !== false ? { fit_markdown: fit } : {}),
    filter: metrics,
  };
}

function rankSections(
  sections: Section[],
  opts: { type: ContentFilterType; query: string; minWords: number; maxSections: number; bm25Threshold?: number; pruneThreshold?: number },
): Section[] {
  const terms = tokenize(opts.query);
  const scored = sections.map(section => ({ ...section, score: opts.type === 'bm25' ? bm25Score(section, terms, sections) : pruneScore(section) }));
  const threshold = opts.type === 'bm25' ? (opts.bm25Threshold ?? 0) : (opts.pruneThreshold ?? 0.15);
  const alwaysKeep = scored.filter(section => section.index === 0 || section.headingDepth === 1);
  const selected = scored
    .filter(section => section.words >= opts.minWords || section.headingDepth > 0 || isCodeOrTable(section.text))
    .filter(section => section.score >= threshold || isCodeOrTable(section.text))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, opts.maxSections);
  const byIndex = new Map<number, Section>();
  for (const section of [...alwaysKeep, ...selected]) byIndex.set(section.index, section);
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

function splitSections(markdown: string): Section[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
      continue;
    }
    if (!inFence && /^#{1,6}\s+/.test(line) && current.length) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks.map((text, index) => ({ index, text, headingDepth: headingDepth(text), words: tokenize(text).length, score: 0 }));
}

function pruneScore(section: Section): number {
  if (isCodeOrTable(section.text)) return 0.9;
  const text = section.text.toLowerCase();
  const navPenalty = /\b(home|login|sign up|subscribe|cookie|privacy policy|terms|advertis|sidebar|footer|navigation)\b/.test(text) ? 0.35 : 0;
  const linkCount = (section.text.match(/\]\(/g) || []).length;
  const linkPenalty = Math.min(0.3, linkCount * 0.05);
  const density = Math.min(0.7, section.words / 30);
  const headingBoost = section.headingDepth > 0 ? 0.15 : 0;
  return Math.max(0, density + headingBoost - navPenalty - linkPenalty);
}

function bm25Score(section: Section, terms: string[], all: Section[]): number {
  if (terms.length === 0) return 0;
  const tokens = tokenize(section.text);
  const avgLen = all.reduce((sum, item) => sum + Math.max(1, item.words), 0) / Math.max(1, all.length);
  let score = section.headingDepth > 0 ? 0.25 : 0;
  for (const term of terms) {
    const tf = tokens.filter(token => token === term).length;
    if (!tf) continue;
    const df = all.filter(item => tokenize(item.text).includes(term)).length || 1;
    const idf = Math.log(1 + (all.length - df + 0.5) / (df + 0.5));
    score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (tokens.length / Math.max(1, avgLen)))));
  }
  return score;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(token => token.length >= 2);
}

function headingDepth(text: string): number {
  const match = text.match(/^(#{1,6})\s+/);
  return match ? match[1].length : 0;
}

function isCodeOrTable(text: string): boolean {
  return text.trim().startsWith('```') || /^\|.+\|/m.test(text);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function roundRatio(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
