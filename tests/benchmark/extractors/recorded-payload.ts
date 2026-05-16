import * as fs from 'fs';
import * as path from 'path';

import type { ExtractorContext, ExtractorResult } from './types';

export interface RecordedPayloadFile {
  payload: string;
  extracted: Record<string, string | null>;
  evidence: {
    source: 'recorded-live' | 'recorded-real';
    capturedAt: string;
    libraryVersion: string;
  };
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, '_');
}

export function recordedPayloadPath(root: string, library: string, fixtureName: string): string {
  return path.join(root, `${safeName(library)}__${safeName(fixtureName)}.json`);
}

export function loadRecordedPayload(library: string, ctx: ExtractorContext): ExtractorResult | null {
  const root = process.env.OPENCHROME_BENCH_RECORDED_TOKENS_DIR;
  if (!root || !ctx.fixtureName) return null;
  const file = recordedPayloadPath(root, library, ctx.fixtureName);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RecordedPayloadFile;
  if (typeof parsed.payload !== 'string') throw new Error(`${file}: payload must be string`);
  if (!parsed.extracted || typeof parsed.extracted !== 'object') throw new Error(`${file}: extracted must be object`);
  if (!parsed.evidence || (parsed.evidence.source !== 'recorded-live' && parsed.evidence.source !== 'recorded-real')) {
    throw new Error(`${file}: evidence.source must be recorded-live or recorded-real`);
  }
  if (typeof parsed.evidence.libraryVersion !== 'string' || parsed.evidence.libraryVersion.length === 0) {
    throw new Error(`${file}: evidence.libraryVersion is required`);
  }
  return { payload: parsed.payload, extracted: parsed.extracted };
}
