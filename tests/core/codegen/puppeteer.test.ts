/**
 * Puppeteer formatter (issue #836):
 *   - emits a snippet for each of the nine supported tools
 *   - the resulting full TS file (header + every snippet + footer) parses
 *     under `ts.transpileModule` with target=es2022 / module=nodenext.
 */

import * as ts from 'typescript';

import {
  formatPuppeteer,
  PUPPETEER_FILE_HEADER,
  PUPPETEER_FILE_FOOTER,
  PUPPETEER_SUPPORTED_TOOLS,
} from '../../../src/core/codegen/formatters/puppeteer';

interface ToolCase {
  tool: string;
  args: Record<string, unknown>;
}

const NINE_TOOL_CASES: ToolCase[] = [
  { tool: 'navigate', args: { url: 'https://example.com/forms.html' } },
  { tool: 'interact', args: { action: 'click', selector: 'button[type=submit]' } },
  { tool: 'form_input', args: { selector: 'input[name=q]', value: 'hello world' } },
  {
    tool: 'fill_form',
    args: {
      fields: [
        { selector: '#user', value: 'alice' },
        { selector: '#pass', value: '${SECRET:TEST_PW}' },
      ],
    },
  },
  { tool: 'page_screenshot', args: { fullPage: true, path: '/tmp/screen.png' } },
  { tool: 'wait_for', args: { type: 'selector', value: '.result', timeout: 5000 } },
  { tool: 'javascript_tool', args: { code: 'document.title' } },
  { tool: 'tabs_create', args: { url: 'https://example.com/new' } },
  { tool: 'tabs_close', args: { tabIds: ['t1', 't2'] } },
];

describe('formatPuppeteer', () => {
  it('covers every tool in PUPPETEER_SUPPORTED_TOOLS via NINE_TOOL_CASES', () => {
    const covered = new Set(NINE_TOOL_CASES.map((c) => c.tool));
    for (const tool of PUPPETEER_SUPPORTED_TOOLS) {
      expect(covered.has(tool)).toBe(true);
    }
  });

  it('returns null for non-9 tools', () => {
    expect(formatPuppeteer('cookies', { action: 'list' })).toBeNull();
    expect(formatPuppeteer('read_page', {})).toBeNull();
  });

  it.each(NINE_TOOL_CASES)('emits a non-empty snippet for $tool', ({ tool, args }) => {
    const snippet = formatPuppeteer(tool, args);
    expect(snippet).not.toBeNull();
    expect(snippet?.length).toBeGreaterThan(0);
  });

  it('preserves secret placeholders verbatim (string literals via JSON.stringify)', () => {
    const snippet = formatPuppeteer('form_input', {
      selector: '#password',
      value: '${SECRET:TEST_PW}',
    });
    expect(snippet).toContain('${SECRET:TEST_PW}');
  });

  it('produces a complete TS file that transpiles without diagnostics', () => {
    const body = [
      PUPPETEER_FILE_HEADER,
      ...NINE_TOOL_CASES.map(({ tool, args }) => formatPuppeteer(tool, args) as string),
      PUPPETEER_FILE_FOOTER,
    ].join('\n');

    const { diagnostics } = ts.transpileModule(body, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      reportDiagnostics: true,
    });

    const syntaxErrors = (diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (syntaxErrors.length > 0) {
      // Surface every error so test output is debuggable.
      const formatted = ts.formatDiagnosticsWithColorAndContext(syntaxErrors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      });
      console.error(formatted);
    }
    expect(syntaxErrors).toEqual([]);
  });
});
