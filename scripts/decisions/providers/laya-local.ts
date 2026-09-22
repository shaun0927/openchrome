import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import type { DecisionCase } from '../../../tests/fixtures/decisions/schema';
import type { DecisionProvider, ProviderAnswer, ProviderInit, ProviderOptions } from './types';
import { abstain } from './types';
import { buildRequest, parseResponse } from './typesafe';

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  readonly type?: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly body?: unknown;
  readonly error?: {
    readonly type?: string;
    readonly message?: string;
    readonly traceback?: string;
  };
}

function enabled(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.LAYA_LOCAL_ENABLED ?? '').toLowerCase());
}

function parseWorkerMessage(line: string): WorkerMessage {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('worker emitted a non-object message');
  }
  return parsed as WorkerMessage;
}

function errorFromWorker(prefix: string, message: WorkerMessage): Error {
  const kind = message.error?.type ?? 'WorkerError';
  const detail = message.error?.message ?? 'unknown worker error';
  const traceback = message.error?.traceback ? `\n${message.error.traceback}` : '';
  return new Error(`${prefix}: ${kind}: ${detail}${traceback}`);
}

class LayaLocalClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = '';
  private nextId = 1;

  constructor(private readonly python: string, private readonly worker: string, private readonly timeoutMs: number) {}

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.waitFor('__ready__').then(() => undefined);
    this.child = spawn(this.python, [this.worker], {
      env: {
        ...process.env,
        HF_HUB_DISABLE_SYMLINKS: process.env.HF_HUB_DISABLE_SYMLINKS ?? '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      // Drain diagnostics without exposing model state or downloaded paths.
      void chunk;
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk.toString('utf8'));
    });
    this.child.on('error', () => this.fail(new Error('laya-local worker could not start')));
    this.child.stdin.on('error', () => this.fail(new Error('laya-local worker input closed')));
    this.child.on('exit', (code, signal) => {
      const err = new Error(`laya-local worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.fail(err);
    });
    return this.ready;
  }

  private waitFor(id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('laya-local worker timed out'));
        this.child?.kill();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async predict(state: unknown, questions: unknown): Promise<unknown> {
    await this.start();
    if (!this.child || !this.child.stdin.writable) throw new Error('laya-local worker is not writable');
    const id = String(this.nextId);
    this.nextId += 1;
    const result = this.waitFor(id);
    this.child.stdin.write(`${JSON.stringify({ id, state, questions })}\n`);
    return result;
  }

  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    this.fail(new Error('laya-local worker closed'));
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    child.stdin.end();
    await exited;
  }

  private handleStdout(text: string): void {
    this.buffer += text;
    if (this.buffer.length > 1_000_000) {
      this.fail(new Error('laya-local worker response too large'));
      this.child?.kill();
      this.buffer = '';
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: WorkerMessage;
    try {
      message = parseWorkerMessage(line);
    } catch (err) {
      this.fail(new Error('laya-local worker emitted invalid JSON'));
      this.child?.kill();
      return;
    }
    if (message.type === 'ready') {
      const ready = this.pending.get('__ready__');
      this.pending.delete('__ready__');
      if (ready) clearTimeout(ready.timer);
      ready?.resolve(undefined);
      return;
    }
    if (message.type === 'fatal') {
      const ready = this.pending.get('__ready__');
      this.pending.delete('__ready__');
      if (ready) clearTimeout(ready.timer);
      ready?.reject(errorFromWorker('laya-local worker failed to initialize', message));
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.body);
    else pending.reject(errorFromWorker('laya-local prediction failed', message));
  }
}

export function createLayaLocalProvider(opts: ProviderOptions = {}): DecisionProvider {
  const python = opts.layaPython ?? process.env.LAYA_PYTHON ?? 'python';
  const worker = opts.layaWorkerPath ?? path.join(__dirname, 'laya_local_worker.py');
  const timeoutMs = opts.layaTimeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('layaTimeoutMs must be positive');
  let client: LayaLocalClient | undefined;
  return {
    name: 'laya-local',
    async init(): Promise<ProviderInit | void> {
      if (!enabled()) return { skipped: 'not enabled; set LAYA_LOCAL_ENABLED=1' };
      client = new LayaLocalClient(python, worker, timeoutMs);
      await client.start();
    },
    async decide(c: DecisionCase): Promise<ProviderAnswer> {
      if (!client) return abstain({ reason: 'not initialized' });
      const request = buildRequest(c);
      const validChoices = Object.keys(request.questions.q.criteria);
      if (validChoices.length > 20) return abstain({ reason: 'choice limit exceeded (20 including abstention)' });
      const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
      const body = await client.predict(state, request.questions);
      return parseResponse(body, validChoices);
    },
    async close(): Promise<void> {
      await client?.close();
    },
  };
}
