import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import { codegenPath, getCodegenMode, normalizeCodegenMode, recordCodegenStep, replayCommandFor, setCodegenMode } from '../../src/core/codegen';

describe('codegen aggregator (#836)', () => {
  let dir: string;
  const prevRoot = process.env.OPENCHROME_CODEGEN_ROOT;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-codegen-'));
    process.env.OPENCHROME_CODEGEN_ROOT = dir;
    setCodegenMode('off');
  });

  afterEach(() => {
    setCodegenMode('off');
    if (prevRoot === undefined) delete process.env.OPENCHROME_CODEGEN_ROOT;
    else process.env.OPENCHROME_CODEGEN_ROOT = prevRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('normalizes unknown modes to off', () => {
    expect(normalizeCodegenMode('puppeteer')).toBe('puppeteer');
    expect(normalizeCodegenMode('bad')).toBe('off');
  });

  test('default off writes no artifacts and returns no replay envelope', () => {
    expect(getCodegenMode()).toBe('off');
    expect(recordCodegenStep('s1', 'navigate', { url: 'http://localhost' })).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('mcp-replay writes raw placeholder args without snippets', () => {
    setCodegenMode('mcp-replay');
    const replay = recordCodegenStep('s1', 'oc_assert', { text: '${SECRET:PW}' });
    expect(replay).toEqual({ tool: 'oc_assert', args: { text: '${SECRET:PW}' } });
    const line = fs.readFileSync(codegenPath('s1', 'mcp-replay'), 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ tool: 'oc_assert', args: { text: '${SECRET:PW}' } });
  });

  test('puppeteer mode writes jsonl and TypeScript snippets for supported tools', () => {
    setCodegenMode('puppeteer');
    const replay = recordCodegenStep('s1', 'navigate', { url: 'http://localhost/form' });
    expect(replay?.puppeteer_snippet).toContain('page.goto');
    expect(fs.readFileSync(codegenPath('s1', 'mcp-replay'), 'utf8')).toContain('navigate');
    const source = fs.readFileSync(codegenPath('s1', 'puppeteer'), 'utf8');
    expect(source).toContain("import puppeteer");
    expect(source).toContain('page.goto');
    expect(source).toContain('main().catch');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    expect(output.diagnostics ?? []).toEqual([]);
  });

  test('playwright mode keeps the generated TypeScript syntactically complete after multiple steps', () => {
    setCodegenMode('playwright');
    recordCodegenStep('s1', 'navigate', { url: 'http://localhost/a' });
    recordCodegenStep('s1', 'wait_for', { timeoutMs: 25 });

    const file = codegenPath('s1', 'playwright');
    const source = fs.readFileSync(file, 'utf8');
    expect(source.match(/main\(\)\.catch/g)).toHaveLength(1);
    expect(source).toContain('await context.close();');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    expect(output.diagnostics ?? []).toEqual([]);
  });

  test('replayCommandFor returns an operator command for each artifact format', () => {
    expect(replayCommandFor('/tmp/s1.mcp-replay.jsonl', 'mcp-replay')).toContain('openchrome replay');
    expect(replayCommandFor('/tmp/s1.puppeteer.ts', 'puppeteer')).toContain('ts-node');
    expect(replayCommandFor('/tmp/s1.playwright.ts', 'playwright')).toContain('ts-node');
  });
});
