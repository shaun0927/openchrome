import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

/**
 * Faithful Node-side port of the legacy in-browser markdown walker in
 * src/tools/crawl.ts (`output_format: 'markdown'`). Used by snapshot tests to
 * lock the legacy contract in CI without spinning up a real browser.
 * Mirrors the depth-first TreeWalker traversal of document.body, the
 * tag-by-tag rules, and the post-processing in crawl.ts:228-276.
 */
export function legacyExtractMarkdown(html: string): string {
  const $ = cheerio.load(html);
  const body = $('body')[0];
  if (!body) return '';

  const parts: string[] = [];

  function visit(el: Element): void {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;

    const text = $(el).text().trim();
    if (tag === 'h1') parts.push(`\n# ${text}\n`);
    else if (tag === 'h2') parts.push(`\n## ${text}\n`);
    else if (tag === 'h3') parts.push(`\n### ${text}\n`);
    else if (tag === 'h4') parts.push(`\n#### ${text}\n`);
    else if (tag === 'h5') parts.push(`\n##### ${text}\n`);
    else if (tag === 'h6') parts.push(`\n###### ${text}\n`);
    else if (tag === 'p') {
      if (text) parts.push(`\n${text}\n`);
    } else if (tag === 'li') {
      if (text) parts.push(`- ${text}`);
    } else if (tag === 'pre') {
      if (text) parts.push(`\n\`\`\`\n${text}\n\`\`\`\n`);
    } else if (tag === 'blockquote') {
      if (text) parts.push(`\n> ${text}\n`);
    }

    for (const child of el.children) {
      if (child.type === 'tag') visit(child as Element);
    }
  }

  for (const child of body.children) {
    if (child.type === 'tag') visit(child as Element);
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
