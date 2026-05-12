/**
 * Playwright formatter (issue #836). Mirrors `puppeteer.spec.ts`.
 */

import * as ts from 'typescript';

import {
  formatPlaywright,
  PLAYWRIGHT_FILE_HEADER,
  PLAYWRIGHT_FILE_FOOTER,
  PLAYWRIGHT_SUPPORTED_TOOLS,
} from '../../../src/core/codegen/formatters/playwright';

interface ToolCase {
  tool: string;
  args: Record<string, unknown>;
}

const NINE_TOOL_CASES: ToolCase[] = [
  { tool: 'navigate', args: { url: 'https://example.com/forms.html' } },
  { tool: 'interact', args: { action: 'click', query: 'Submit' } },
  { tool: 'form_input', args: { ref: '1234', value: 'hello world' } },
  {
    tool: 'fill_form',
    args: {
      fields: { '#user': 'alice', '#pass': '${SECRET:TEST_PW}' },
    },
  },
  { tool: 'page_screenshot', args: { fullPage: true, path: '/tmp/screen.png' } },
  { tool: 'wait_for', args: { type: 'selector', value: '.result', timeout: 5000 } },
  { tool: 'javascript_tool', args: { code: 'document.title' } },
  { tool: 'tabs_create', args: { url: 'https://example.com/new' } },
  { tool: 'tabs_close', args: { tabIds: ['t1'] } },
];

describe('formatPlaywright', () => {
  it('covers every tool in PLAYWRIGHT_SUPPORTED_TOOLS', () => {
    const covered = new Set(NINE_TOOL_CASES.map((c) => c.tool));
    for (const tool of PLAYWRIGHT_SUPPORTED_TOOLS) {
      expect(covered.has(tool)).toBe(true);
    }
  });

  it('returns null for non-9 tools', () => {
    expect(formatPlaywright('cookies', { action: 'list' })).toBeNull();
  });

  it.each(NINE_TOOL_CASES)('emits a non-empty snippet for $tool', ({ tool, args }) => {
    const snippet = formatPlaywright(tool, args);
    expect(snippet).not.toBeNull();
    expect(snippet?.length).toBeGreaterThan(0);
  });

  it('preserves secret placeholders verbatim', () => {
    const snippet = formatPlaywright('form_input', {
      ref: 'ref_1',
      value: '${SECRET:TEST_PW}',
    });
    expect(snippet).toContain('${SECRET:TEST_PW}');
  });

  it('produces a complete TS file that transpiles without diagnostics', () => {
    const body = [
      PLAYWRIGHT_FILE_HEADER,
      ...NINE_TOOL_CASES.map(({ tool, args }) => formatPlaywright(tool, args) as string),
      PLAYWRIGHT_FILE_FOOTER,
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
      const formatted = ts.formatDiagnosticsWithColorAndContext(syntaxErrors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      });
      console.error(formatted);
    }
    expect(syntaxErrors).toEqual([]);
  });

  it('preserves target selection for tabs_close instead of closing every page', () => {
    const snippet = formatPlaywright('tabs_close', { tabIds: ['target-a', 'target-b'] })!;
    expect(snippet).toContain('new Set<string>(["target-a","target-b"])');
    expect(snippet).toContain("Target.getTargetInfo");
    expect(snippet).toContain('targetIds.has(info.targetInfo.targetId)');
    expect(snippet).not.toContain('for (const p of context.pages()) { await p.close(); }');
  });


  it('uses schema-compliant interact query arguments', () => {
    const snippet = formatPlaywright('interact', { action: 'double_click', query: 'Buy now' })!;
    expect(snippet).toContain('Buy now');
    expect(snippet).not.toContain('undefined');
  });

  it('does not emit undefined selectors for ref-based form_input calls', () => {
    const snippet = formatPlaywright('form_input', { ref: 'ref_7', value: 'hello' })!;
    expect(snippet).toContain('ref_7');
    expect(snippet).toContain('hello');
    expect(snippet).not.toContain('undefined');
  });

});
