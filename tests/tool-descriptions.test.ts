/// <reference types="jest" />
/**
 * Tool description audit (issue #841).
 *
 * Verifies that the canonical shortlist of routing-sensitive tools embeds
 * "When to use" / "When NOT to use" guidance directly in their `description`
 * field, so an LLM picks the right tool on the first call without waiting
 * for runtime Hint Engine emission.
 */

import * as fs from 'fs';
import * as path from 'path';

interface ShortlistEntry {
  toolName: string;       // registered MCP name
  sourceFile: string;     // relative path from repo root
}

// The exhaustive 14-entry shortlist. `journal` is intentionally absent
// because no tool is registered under that bare name (only `oc_journal`).
const SHORTLIST: ShortlistEntry[] = [
  { toolName: 'read_page',       sourceFile: 'src/tools/read-page.ts' },
  { toolName: 'query_dom',       sourceFile: 'src/tools/query-dom.ts' },
  { toolName: 'find',            sourceFile: 'src/tools/find.ts' },
  { toolName: 'inspect',         sourceFile: 'src/tools/inspect.ts' },
  { toolName: 'interact',        sourceFile: 'src/tools/interact.ts' },
  { toolName: 'computer',        sourceFile: 'src/tools/computer.ts' },
  { toolName: 'act',             sourceFile: 'src/tools/act.ts' },
  { toolName: 'javascript_tool', sourceFile: 'src/tools/javascript.ts' },
  { toolName: 'crawl',           sourceFile: 'src/tools/crawl.ts' },
  { toolName: 'crawl_sitemap',   sourceFile: 'src/tools/crawl-sitemap.ts' },
  { toolName: 'extract_data',    sourceFile: 'src/tools/extract-data.ts' },
  { toolName: 'page_screenshot', sourceFile: 'src/tools/page-screenshot.ts' },
  { toolName: 'oc_journal',      sourceFile: 'src/tools/journal.ts' },
  { toolName: 'validate_page',   sourceFile: 'src/tools/validate-page.ts' },
];

const REPO_ROOT = path.resolve(__dirname, '..');
const MAX_DESCRIPTION_CHARS = 400;

/**
 * Extract the value of the `description:` field for the tool definition whose
 * `name:` matches `expectedName`. Returns the resolved string (concatenations
 * collapsed). Throws if not found.
 */
function extractDescription(source: string, expectedName: string): string {
  // Find the definition block by locating `name: 'expectedName'` (or double quote)
  const nameRe = new RegExp(`name:\\s*['"]${expectedName}['"]`);
  const nameIdx = source.search(nameRe);
  if (nameIdx === -1) {
    throw new Error(`Could not locate tool registration name: '${expectedName}'`);
  }
  // From the name marker, find the next `description:` field
  const fromName = source.slice(nameIdx);
  const descMatch = fromName.match(/description:\s*([\s\S]*?),\s*\n\s*inputSchema:/);
  if (!descMatch) {
    throw new Error(`Could not locate description for tool '${expectedName}'`);
  }
  const raw = descMatch[1].trim();
  return evaluateStringExpression(raw);
}

/**
 * Resolve a TypeScript string expression of the form `'a' + 'b'` or single
 * quoted/double quoted literal. We only support the subset that openchrome
 * uses in tool definitions: concatenation of single/double-quoted strings,
 * possibly across lines. Template literals are also handled for completeness.
 */
function evaluateStringExpression(expr: string): string {
  // Strip line continuations / collapse whitespace between concatenations
  // by repeatedly matching string literal | + | template-literal
  let remaining = expr;
  const parts: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (remaining.startsWith("'") || remaining.startsWith('"')) {
      const quote = remaining[0];
      let i = 1;
      while (i < remaining.length) {
        if (remaining[i] === '\\') { i += 2; continue; }
        if (remaining[i] === quote) break;
        i++;
      }
      const literal = remaining.slice(1, i);
      parts.push(literal
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\'));
      remaining = remaining.slice(i + 1);
    } else if (remaining.startsWith('`')) {
      let i = 1;
      while (i < remaining.length) {
        if (remaining[i] === '\\') { i += 2; continue; }
        if (remaining[i] === '`') break;
        i++;
      }
      const literal = remaining.slice(1, i);
      parts.push(literal
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\`/g, '`')
        .replace(/\\\\/g, '\\'));
      remaining = remaining.slice(i + 1);
    } else if (remaining.startsWith('+')) {
      remaining = remaining.slice(1);
    } else {
      break;
    }
  }
  return parts.join('');
}

describe('Tool description guidance (issue #841)', () => {
  describe.each(SHORTLIST)('$toolName', ({ toolName, sourceFile }) => {
    const fullPath = path.join(REPO_ROOT, sourceFile);
    const source = fs.readFileSync(fullPath, 'utf8');
    const description = extractDescription(source, toolName);

    test('contains "When to use:" guidance line', () => {
      expect(description).toMatch(/When to use:/);
    });

    test('contains "When NOT to use:" guidance line', () => {
      expect(description).toMatch(/When NOT to use:/);
    });

    test('"When NOT to use" line is non-empty (>= 8 chars after the colon)', () => {
      const m = description.match(/When NOT to use:\s*([^\n]+)/);
      expect(m).not.toBeNull();
      expect(m![1].trim().length).toBeGreaterThanOrEqual(8);
    });

    test(`description length <= ${MAX_DESCRIPTION_CHARS} chars`, () => {
      expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    });
  });

  test('shortlist exhaustively covers exactly 14 tools', () => {
    expect(SHORTLIST).toHaveLength(14);
    const names = SHORTLIST.map(s => s.toolName).sort();
    const unique = Array.from(new Set(names));
    expect(unique).toHaveLength(14);
  });

  test('form_input description preserves multiple-field fill_form guidance', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/tools/form-input.ts'), 'utf8');
    const description = extractDescription(source, 'form_input');

    expect(description).toMatch(/When NOT to use:/);
    expect(description).toMatch(/fill_form\(\{fields:\{\.\.\.\}\}\)/);
    expect(description).toMatch(/multiple fields/);
  });

  test('string evaluator handles escaped backticks inside template literals', () => {
    expect(evaluateStringExpression('`Use \\`literal\\` ticks`')).toBe('Use `literal` ticks');
  });
});
