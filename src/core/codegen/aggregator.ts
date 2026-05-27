/**
 * Opt-in replay/codegen aggregator (#836).
 *
 * Default mode is `off`, so existing tool responses and runtime behavior are
 * byte-identical unless the operator explicitly starts openchrome with
 * `--codegen <format>` or sets OPENCHROME_CODEGEN.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodegenMode = 'off' | 'puppeteer' | 'playwright' | 'mcp-replay';

export interface ReplayEnvelope {
  tool: string;
  args: Record<string, unknown>;
  puppeteer_snippet?: string;
  playwright_snippet?: string;
}

let mode: CodegenMode = normalizeCodegenMode(process.env.OPENCHROME_CODEGEN);

export function normalizeCodegenMode(value: unknown): CodegenMode {
  return value === 'puppeteer' || value === 'playwright' || value === 'mcp-replay' ? value : 'off';
}

export function setCodegenMode(next: CodegenMode): void { mode = next; }
export function getCodegenMode(): CodegenMode { return mode; }
export function isCodegenEnabled(): boolean { return mode !== 'off'; }

export function defaultCodegenRoot(): string {
  return process.env.OPENCHROME_CODEGEN_ROOT || path.join(os.homedir(), '.openchrome', 'codegen');
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'default';
}

export function codegenPath(sessionId: string, format: Exclude<CodegenMode, 'off'>, root = defaultCodegenRoot()): string {
  const sid = sanitizeSessionId(sessionId);
  const ext = format === 'mcp-replay' ? 'jsonl' : 'ts';
  return path.join(root, `${sid}.${format}.${ext}`);
}

function q(value: unknown): string { return JSON.stringify(String(value ?? '')); }
function json(value: unknown): string { return JSON.stringify(value ?? {}, null, 0); }

const SNIPPET_TOOLS = new Set(['navigate', 'interact', 'form_input', 'fill_form', 'page_screenshot', 'wait_for', 'javascript_tool', 'tabs_create', 'tabs_close']);

export function buildReplayEnvelope(tool: string, args: Record<string, unknown>): ReplayEnvelope {
  const envelope: ReplayEnvelope = { tool, args: { ...args } };
  if (!SNIPPET_TOOLS.has(tool)) return envelope;
  envelope.puppeteer_snippet = buildPuppeteerSnippet(tool, args);
  envelope.playwright_snippet = buildPlaywrightSnippet(tool, args);
  return envelope;
}

function buildPuppeteerSnippet(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'navigate': return `await page.goto(${q(args.url)}, { waitUntil: 'domcontentloaded' });`;
    case 'tabs_create': return `const page = await browser.newPage();\nawait page.goto(${q(args.url)}, { waitUntil: 'domcontentloaded' });`;
    case 'tabs_close': return `await page.close(); // ${json({ tabId: args.tabId, tabIds: args.tabIds, workerId: args.workerId })}`;
    case 'interact': return `await page.locator(${q(args.query ?? args.ref ?? 'selector')}).click();`;
    case 'form_input': return `await page.locator(${q(args.ref ?? args.selector ?? 'input')}).fill(${q(args.value)});`;
    case 'fill_form': return `// fill_form\nfor (const [selector, value] of Object.entries(${json(args.fields)})) await page.locator(selector).fill(String(value));`;
    case 'page_screenshot': return `await page.screenshot({ path: ${q(args.path ?? 'screenshot.png')}, fullPage: ${args.fullPage === true ? 'true' : 'false'} });`;
    case 'wait_for': return args.selector ? `await page.waitForSelector(${q(args.selector)}, { timeout: ${Number(args.timeout ?? args.timeoutMs ?? 5000)} });` : `await page.waitForTimeout(${Number(args.timeout ?? args.timeoutMs ?? 1000)});`;
    case 'javascript_tool': return `await page.evaluate(${q(args.expression ?? args.code ?? '')});`;
    default: return `// ${tool} ${json(args)}`;
  }
}

function buildPlaywrightSnippet(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'navigate': return `await page.goto(${q(args.url)}, { waitUntil: 'domcontentloaded' });`;
    case 'tabs_create': return `const page = await context.newPage();\nawait page.goto(${q(args.url)}, { waitUntil: 'domcontentloaded' });`;
    case 'tabs_close': return `await page.close(); // ${json({ tabId: args.tabId, tabIds: args.tabIds, workerId: args.workerId })}`;
    case 'interact': return `await page.getByText(${q(args.query ?? args.ref ?? 'target')}).click();`;
    case 'form_input': return `await page.locator(${q(args.ref ?? args.selector ?? 'input')}).fill(${q(args.value)});`;
    case 'fill_form': return `// fill_form\nfor (const [selector, value] of Object.entries(${json(args.fields)})) await page.locator(selector).fill(String(value));`;
    case 'page_screenshot': return `await page.screenshot({ path: ${q(args.path ?? 'screenshot.png')}, fullPage: ${args.fullPage === true ? 'true' : 'false'} });`;
    case 'wait_for': return args.selector ? `await page.waitForSelector(${q(args.selector)}, { timeout: ${Number(args.timeout ?? args.timeoutMs ?? 5000)} });` : `await page.waitForTimeout(${Number(args.timeout ?? args.timeoutMs ?? 1000)});`;
    case 'javascript_tool': return `await page.evaluate(${q(args.expression ?? args.code ?? '')});`;
    default: return `// ${tool} ${json(args)}`;
  }
}

function tsFooter(format: 'puppeteer' | 'playwright'): string {
  const closeContext = format === 'playwright' ? '  await context.close();\n' : '';
  return `${closeContext}  await browser.close();\n}\n\nmain().catch((error) => {\n  console.error(error);\n  process.exitCode = 1;\n});\n`;
}

function stripTsFooter(source: string): string {
  const marker = '\n  await browser.close();\n}\n\nmain().catch';
  const index = source.indexOf(marker);
  if (index === -1) return source;
  return source.slice(0, index) + '\n';
}

function ensureTsHeader(file: string, format: 'puppeteer' | 'playwright'): void {
  if (fs.existsSync(file)) return;
  const header = format === 'puppeteer'
    ? "import puppeteer from 'puppeteer-core';\n\nasync function main() {\n  const browser = await puppeteer.launch({ headless: true });\n  const page = await browser.newPage();\n"
    : "import { chromium } from 'playwright';\n\nasync function main() {\n  const browser = await chromium.launch();\n  const context = await browser.newContext();\n  const page = await context.newPage();\n";
  fs.writeFileSync(file, header + tsFooter(format), 'utf8');
}

export function recordCodegenStep(sessionId: string, tool: string, rawArgs: Record<string, unknown>): ReplayEnvelope | undefined {
  if (!isCodegenEnabled()) return undefined;
  const root = defaultCodegenRoot();
  fs.mkdirSync(root, { recursive: true });
  const envelope = buildReplayEnvelope(tool, rawArgs);
  const event = { ts: Date.now(), tool, args: envelope.args };
  fs.appendFileSync(codegenPath(sessionId, 'mcp-replay', root), JSON.stringify(event) + '\n', 'utf8');
  if (mode === 'puppeteer' || mode === 'playwright') {
    const file = codegenPath(sessionId, mode, root);
    ensureTsHeader(file, mode);
    const snippet = mode === 'puppeteer' ? envelope.puppeteer_snippet : envelope.playwright_snippet;
    const body = stripTsFooter(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${body}  ${snippet ?? `// ${tool} ${json(rawArgs)}`}\n${tsFooter(mode)}`, 'utf8');
  }
  return envelope;
}

export function listCodegenFiles(root = defaultCodegenRoot()): string[] {
  try {
    return fs.readdirSync(root).map((f) => path.join(root, f)).filter((f) => fs.statSync(f).isFile()).sort();
  } catch { return []; }
}

export function replayCommandFor(file: string, format: Exclude<CodegenMode, 'off'>): string {
  const qFile = JSON.stringify(file);
  if (format === 'mcp-replay') return `openchrome replay --from ${qFile}`;
  // puppeteer and playwright artifacts are both standalone TypeScript scripts
  // that run via ts-node (playwright uses `import { chromium } from 'playwright'`,
  // not `playwright/test`, so `npx playwright test` is not the right invocation).
  return `npx ts-node ${qFile}`;
}
