/**
 * Any-file → Markdown extraction backend, with an opt-in PDF path.
 *
 * When an openchrome navigation downloads a document rather than
 * rendering it (application/pdf, application/vnd.openxmlformats-*,
 * text/csv), the current extraction strategies have nothing to bite on
 * — the DOM is either empty or displays a PDF viewer stub. Users
 * routinely work around this by writing a bespoke post-download parser,
 * which multiplies over document types.
 *
 * This module defines a small backend registry that picks a parser
 * based on Content-Type or file extension and returns Markdown. It
 * ships with a default `text/plain`, `text/html`, `text/csv`, and
 * `application/json` implementations that are trivially portable
 * inside Node. PDF is intentionally implemented as an *optional*
 * external-binary backend (markitdown or docling), consistent with the
 * TLS fast-path adapter in pack P9: heavy tools are opt-in and
 * auto-detected, never bundled.
 *
 * Contract
 * --------
 *   const backend = createExtractionBackend();
 *   const result = await backend.extract({
 *     bytes,
 *     contentType: 'application/pdf',
 *     filename: 'invoice.pdf',
 *   });
 *   if (result.status === 'ok') use(result.markdown);
 *   else if (result.status === 'unsupported') fallbackToHtml();
 *
 * Clean-room. Idea attribution per docs/rebirth/ULTIMATE-CENSUS-2026-07-18:
 * markitdown (C14), docling (C15). No code copied from either project.
 */

import { spawn } from 'node:child_process';

export type ExtractionStatus = 'ok' | 'unsupported' | 'error';

export interface ExtractionInput {
  bytes: Uint8Array;
  contentType?: string;
  filename?: string;
  /** Best-effort URL, only used for cross-reference in the returned metadata. */
  sourceUrl?: string;
}

export interface ExtractionResult {
  status: ExtractionStatus;
  markdown?: string;
  backend?: string;
  reason?: string;
  metadata?: Record<string, string>;
}

export type BackendId = 'text' | 'html' | 'csv' | 'json' | 'pdf-markitdown' | 'pdf-docling';

export interface ExtractionBackendOptions {
  /** Absolute path to a `markitdown` binary. Auto-detected via env if omitted. */
  markitdownPath?: string;
  /** Absolute path to a `docling` CLI. Auto-detected via env if omitted. */
  doclingPath?: string;
  /** Preferred PDF backend when both are available. Default `markitdown`. */
  preferredPdfBackend?: 'markitdown' | 'docling';
  /** Injected spawner, primarily for tests. */
  spawnImpl?: typeof spawn;
  /** Command timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

export interface ExtractionBackend {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
  supports(contentType?: string, filename?: string): BackendId | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createExtractionBackend(
  options: ExtractionBackendOptions = {},
): ExtractionBackend {
  const markitdownPath = options.markitdownPath ?? process.env.OPENCHROME_MARKITDOWN;
  const doclingPath = options.doclingPath ?? process.env.OPENCHROME_DOCLING;
  const preferred = options.preferredPdfBackend ?? 'markitdown';
  const spawner = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pickPdfBackend = (): BackendId | null => {
    if (preferred === 'markitdown' && markitdownPath) return 'pdf-markitdown';
    if (preferred === 'docling' && doclingPath) return 'pdf-docling';
    if (markitdownPath) return 'pdf-markitdown';
    if (doclingPath) return 'pdf-docling';
    return null;
  };

  const supports = (contentType?: string, filename?: string): BackendId | null => {
    const ext = filename ? extension(filename) : '';
    const ct = (contentType ?? '').toLowerCase();
    if (ct.startsWith('text/plain') || ext === 'txt' || ext === 'log') return 'text';
    if (ct.startsWith('text/html') || ext === 'html' || ext === 'htm') return 'html';
    if (ct.startsWith('text/csv') || ext === 'csv') return 'csv';
    if (ct.startsWith('application/json') || ext === 'json') return 'json';
    if (ct === 'application/pdf' || ext === 'pdf') return pickPdfBackend();
    return null;
  };

  return {
    supports,
    async extract(input) {
      const backend = supports(input.contentType, input.filename);
      if (!backend) {
        return {
          status: 'unsupported',
          reason: `no backend for content-type=${input.contentType ?? '?'} filename=${input.filename ?? '?'}`,
        };
      }
      switch (backend) {
        case 'text': return runText(input, backend);
        case 'html': return runHtml(input, backend);
        case 'csv': return runCsv(input, backend);
        case 'json': return runJson(input, backend);
        case 'pdf-markitdown':
          return runExternal(input, backend, markitdownPath!, ['--stdin'], spawner, timeoutMs);
        case 'pdf-docling':
          return runExternal(input, backend, doclingPath!, ['-', '--to', 'md'], spawner, timeoutMs);
      }
    },
  };
}

function extension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx + 1).toLowerCase();
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function runText(input: ExtractionInput, backend: BackendId): Promise<ExtractionResult> {
  return { status: 'ok', backend, markdown: decode(input.bytes) };
}

async function runHtml(input: ExtractionInput, backend: BackendId): Promise<ExtractionResult> {
  // Extremely small HTML → Markdown pass: strip tags, decode a handful of
  // entities. Enough for downloaded snippets; not a Markdown converter.
  const raw = decode(input.bytes);
  const stripped = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return { status: 'ok', backend, markdown: stripped };
}

async function runCsv(input: ExtractionInput, backend: BackendId): Promise<ExtractionResult> {
  const raw = decode(input.bytes).trim();
  if (raw.length === 0) return { status: 'ok', backend, markdown: '' };
  const rows = raw.split(/\r?\n/).map(parseCsvRow);
  if (rows.length === 0) return { status: 'ok', backend, markdown: '' };
  const header = rows[0]!;
  const body = rows.slice(1);
  const out: string[] = [];
  out.push(`| ${header.join(' | ')} |`);
  out.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of body) {
    // pad/truncate to header width for stable Markdown tables
    const padded = [...row];
    while (padded.length < header.length) padded.push('');
    padded.length = header.length;
    out.push(`| ${padded.map(escapeCell).join(' | ')} |`);
  }
  return { status: 'ok', backend, markdown: out.join('\n') };
}

function parseCsvRow(line: string): string[] {
  // Minimal CSV parser: handles double-quoted cells with embedded commas
  // and doubled quotes. Not RFC-4180 exhaustive; sufficient for downloaded
  // artefacts.
  const out: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else {
      if (ch === ',') { out.push(cell); cell = ''; }
      else if (ch === '"') inQuotes = true;
      else cell += ch;
    }
  }
  out.push(cell);
  return out;
}

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|');
}

async function runJson(input: ExtractionInput, backend: BackendId): Promise<ExtractionResult> {
  try {
    const parsed = JSON.parse(decode(input.bytes));
    return {
      status: 'ok',
      backend,
      markdown: '```json\n' + JSON.stringify(parsed, null, 2) + '\n```',
    };
  } catch (error) {
    return {
      status: 'error',
      backend,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function runExternal(
  input: ExtractionInput,
  backend: BackendId,
  binary: string,
  args: readonly string[],
  spawner: typeof spawn,
  timeoutMs: number,
): Promise<ExtractionResult> {
  return new Promise((resolve) => {
    const child = spawner(binary, args as string[], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: 'error', backend, reason: 'timeout' });
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: 'error', backend, reason: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({ status: 'error', backend, reason: stderr.trim() || `exit=${code}` });
        return;
      }
      resolve({ status: 'ok', backend, markdown: stdout });
    });
    child.stdin.write(input.bytes);
    child.stdin.end();
  });
}
