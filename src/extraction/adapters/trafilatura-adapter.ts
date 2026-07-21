/**
 * trafilatura reader adapter — HTML→markdown via a shell-out to a
 * user-installed Python `trafilatura` binary.
 *
 * Why this exists
 * ---------------
 * trafilatura wins content-extraction benchmarks on real-world news
 * and article pages by a wide margin (evaluations by ScrapingHub,
 * commoncrawl, and internal). Openchrome should be able to route
 * "give me the article from this HTML" through trafilatura without
 * adding a Python runtime dependency to the core npm package.
 *
 * Contract
 * --------
 * - This adapter registers a `trafilatura` backend that implements
 *   `fromHtml()`. It shells out to `trafilatura --json` and reads
 *   markdown from stdout.
 * - The binary path is resolved via the `TRAFILATURA_BIN` env var,
 *   falling back to `trafilatura` on PATH. When the binary is
 *   missing, registration is a no-op — the module still imports
 *   cleanly and callers who list backends simply won't see it.
 * - No network I/O in this adapter — trafilatura works from HTML
 *   the caller has already fetched (via openchrome's Chrome or a
 *   sibling reader backend).
 *
 * Origin credit
 * -------------
 * Idiom from trafilatura's `extract()` API (Apache-2.0). This is a
 * clean-room shell adapter; no upstream Python code copied.
 */

import { spawn } from 'child_process';
import type { ReaderBackend, ReaderInput, ReaderResult } from '../reader-backend';
import { registerReaderBackend } from '../reader-backend';

const BACKEND_NAME = 'trafilatura';
const DEFAULT_TIMEOUT_MS = 20000;

export interface TrafilaturaAdapterOptions {
  /** Override binary path (default: env TRAFILATURA_BIN or 'trafilatura'). */
  binPath?: string;
  /** Timeout per invocation. */
  timeoutMs?: number;
}

export function createTrafilaturaBackend(opts: TrafilaturaAdapterOptions = {}): ReaderBackend {
  const binPath = opts.binPath ?? process.env.TRAFILATURA_BIN ?? 'trafilatura';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: BACKEND_NAME,
    capabilities: ['html'] as const,

    async fromHtml(input: ReaderInput & { html: string }): Promise<ReaderResult> {
      const startedAt = Date.now();
      const args = ['--output-format', 'markdown', '--no-comments', '--no-tables'];
      const perCallTimeout = input.timeoutMs ?? timeoutMs;

      return await new Promise<ReaderResult>((resolve, reject) => {
        const child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          reject(new Error(`trafilatura timed out after ${perCallTimeout}ms`));
        }, perCallTimeout);

        child.stdout.on('data', (b) => stdoutChunks.push(b));
        child.stderr.on('data', (b) => stderrChunks.push(b));

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`trafilatura spawn failed: ${err.message}`));
        });

        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 500);
            reject(new Error(`trafilatura exited with code ${code}: ${stderr}`));
            return;
          }
          const markdown = Buffer.concat(stdoutChunks).toString('utf8').trim();
          resolve({
            markdown,
            backend: BACKEND_NAME,
            resolvedUrl: input.url,
            inputBytes: Buffer.byteLength(input.html, 'utf8'),
            elapsedMs: Date.now() - startedAt,
          });
        });

        child.stdin.end(input.html);
      });
    },
  };
}

/**
 * Register the trafilatura backend under its canonical name. Safe to
 * call multiple times — the registry overwrites.
 */
export function registerTrafilaturaBackend(opts: TrafilaturaAdapterOptions = {}): ReaderBackend {
  const backend = createTrafilaturaBackend(opts);
  registerReaderBackend(backend);
  return backend;
}
