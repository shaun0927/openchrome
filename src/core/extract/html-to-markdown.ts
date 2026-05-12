import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

export interface ExtractOptions {
  onlyMainContent?: boolean;
}

export interface ExtractResult {
  html: string;
  stripped: string[];
}

export interface ToMarkdownOptions {
  includeLinks?: boolean;
}

const ALWAYS_REMOVE = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  '[aria-hidden="true"]',
];

const MAIN_CONTENT_REMOVE = [
  'header',
  'footer',
  'nav',
  'aside',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="navigation"]',
  '.cookie-banner',
  '[class*="cookie-consent"]',
  '[class*="advert"]',
  '[class*="popup"]',
];

const MAIN_SCOPE_SELECTORS = ['main', 'article', '[role="main"]'];

export function extractMainContent(html: string, opts: ExtractOptions = {}): ExtractResult {
  const $ = cheerio.load(html);
  const stripped: string[] = [];

  for (const sel of ALWAYS_REMOVE) {
    const els = $(sel);
    if (els.length > 0) {
      stripped.push(sel);
      els.remove();
    }
  }

  if (opts.onlyMainContent !== false) {
    for (const sel of MAIN_CONTENT_REMOVE) {
      const els = $(sel);
      if (els.length > 0) {
        stripped.push(sel);
        els.remove();
      }
    }

    for (const sel of MAIN_SCOPE_SELECTORS) {
      const candidate = $(sel).first();
      if (candidate.length > 0 && candidate.text().trim().length > 0) {
        const inner = $.html(candidate);
        return { html: inner, stripped };
      }
    }
  }

  const body = $('body').first();
  const out = body.length > 0 ? $.html(body) : $.html();
  return { html: out, stripped };
}

function buildTurndown(opts: ToMarkdownOptions): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  if (opts.includeLinks === false) {
    td.addRule('strip-links', {
      filter: 'a',
      replacement: (content: string) => content,
    });
  }

  td.addRule('gfm-table', {
    filter: 'table',
    replacement: (_content: string, node: TurndownService.Node) => {
      const tableEl = node as unknown as HTMLTableElement;
      const rows = Array.from(tableEl.querySelectorAll('tr'));
      if (rows.length === 0) return '';

      const cellText = (cell: Element): string =>
        (cell.textContent || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

      const matrix: string[][] = rows.map((r) =>
        Array.from(r.querySelectorAll('th,td')).map(cellText),
      );

      const colCount = Math.max(...matrix.map((row) => row.length));
      if (colCount === 0) return '';

      for (const row of matrix) {
        while (row.length < colCount) row.push('');
      }

      const headerRowIdx = rows.findIndex((r) => r.querySelector('th'));
      const headerRow = headerRowIdx >= 0 ? matrix[headerRowIdx] : matrix[0];
      const bodyRows = headerRowIdx >= 0 ? matrix.filter((_, i) => i !== headerRowIdx) : matrix.slice(1);

      const lines = [
        `| ${headerRow.join(' | ')} |`,
        `| ${headerRow.map(() => '---').join(' | ')} |`,
        ...bodyRows.map((row) => `| ${row.join(' | ')} |`),
      ];
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });

  return td;
}

export function toMarkdown(cleanedHtml: string, opts: ToMarkdownOptions = {}): string {
  const td = buildTurndown(opts);
  const md = td.turndown(cleanedHtml);
  return md.replace(/\n{3,}/g, '\n\n').trim();
}
