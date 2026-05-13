import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { redactValue } from '../core/trace/redactor.js';
import type { RunEvent, RunRecord } from './types.js';

export interface RunEvidenceOptions {
  rootDir?: string;
  now?: () => number;
  idFactory?: () => string;
  includeScreenshot?: boolean;
}

export interface CaptureRunEvidenceInput {
  record: RunRecord;
  trigger: 'tool_error' | 'stuck' | 'postcondition_violation' | 'tab_eviction' | 'reconnect_failure' | 'max_budget_exceeded';
  failureCategory?: string;
  event?: RunEvent;
  message?: string;
}

export interface RunEvidenceBundle {
  version: 1;
  evidence_id: string;
  run_id: string;
  session_id?: string;
  tab_id?: string;
  trigger: CaptureRunEvidenceInput['trigger'];
  failure_category: string;
  captured_at: number;
  metadata: {
    url?: string;
    title?: string;
    screenshot: { included: boolean; reason?: string };
    network: { included: boolean; reason?: string };
    console: { included: boolean; reason?: string };
  };
  recent_tool_calls: Array<{ tool?: string; ok?: boolean; duration_ms?: number; message?: string }>;
  message?: string;
}

export function defaultRunEvidenceRootDir(): string {
  return process.env.OPENCHROME_RUN_EVIDENCE_DIR || path.join(os.homedir(), '.openchrome', 'run-evidence');
}

export class RunEvidenceCapture {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly includeScreenshot: boolean;

  constructor(options: RunEvidenceOptions = {}) {
    this.rootDir = options.rootDir ?? defaultRunEvidenceRootDir();
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.includeScreenshot = options.includeScreenshot === true;
  }

  capture(input: CaptureRunEvidenceInput): { path: string; bundle: RunEvidenceBundle } | null {
    try {
      const bundle = this.buildBundle(input);
      const dir = path.join(this.rootDir, sanitizePathSegment(input.record.run_id), bundle.evidence_id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'metadata.json');
      fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
      return { path: file, bundle };
    } catch {
      return null;
    }
  }

  buildBundle(input: CaptureRunEvidenceInput): RunEvidenceBundle {
    const eventMetadata = input.event?.metadata ?? {};
    const url = stringMetadata(eventMetadata.url);
    const title = stringMetadata(eventMetadata.title);
    return redactValue({
      version: 1,
      evidence_id: `evidence-${this.idFactory()}`,
      run_id: input.record.run_id,
      session_id: input.event?.session_id ?? input.record.session_id,
      tab_id: input.event?.tab_id ?? input.record.tab_id,
      trigger: input.trigger,
      failure_category: input.failureCategory ?? inferFailureCategory(input),
      captured_at: this.now(),
      metadata: {
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        screenshot: this.includeScreenshot
          ? { included: false, reason: 'screenshot capture requires live page context; use oc_evidence_bundle for full snapshot' }
          : { included: false, reason: 'disabled by run evidence safe mode' },
        network: { included: false, reason: 'no network slice was attached to the run event' },
        console: { included: false, reason: 'no console slice was attached to the run event' },
      },
      recent_tool_calls: input.record.events
        .filter((event) => event.kind === 'tool_call_finished')
        .slice(-10)
        .map((event) => ({ tool: event.tool, ok: event.ok, duration_ms: event.duration_ms, message: event.message })),
      ...(input.message ? { message: input.message } : {}),
    } satisfies RunEvidenceBundle) as RunEvidenceBundle;
  }
}

export function shouldAutoCaptureRunEvidence(event: RunEvent): boolean {
  if (event.kind !== 'tool_call_finished') return false;
  if (event.ok === false) return true;
  const status = String((event.metadata?.progress as Record<string, unknown> | undefined)?.status ?? '');
  return status === 'stuck' || status === 'stalling';
}

export function evidenceTriggerForEvent(event: RunEvent): CaptureRunEvidenceInput['trigger'] {
  if (event.ok === false) return 'tool_error';
  const status = String((event.metadata?.progress as Record<string, unknown> | undefined)?.status ?? '');
  if (status === 'stuck' || status === 'stalling') return 'stuck';
  return 'tool_error';
}

function inferFailureCategory(input: CaptureRunEvidenceInput): string {
  if (input.failureCategory) return input.failureCategory;
  const text = `${input.message ?? ''} ${input.event?.message ?? ''} ${JSON.stringify(input.event?.metadata ?? {})}`;
  if (/stuck|stall|no.progress/i.test(text)) return 'NO_PROGRESS';
  if (/timeout|timed out/i.test(text)) return 'MAX_STEPS_EXCEEDED';
  if (/stale|not found|selector|element/i.test(text)) return 'ELEMENT_NOT_FOUND';
  return 'UNKNOWN';
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 1000) : undefined;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'run';
}
