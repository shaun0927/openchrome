/** Opt-in visual trajectory evidence bundles for perception/debug workflows. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

export interface VisualTrajectoryEntry {
  version: 1;
  traceId: string;
  sessionId: string;
  tabId: string;
  url: string;
  timestamp: number;
  toolName: string;
  action?: {
    kind: string;
    target?: string;
    strategy?: string;
  };
  perception?: {
    provider: string;
    snapshotPath?: string;
    elementCount: number;
    latencyMs?: number;
    warnings: string[];
  };
  screenshots?: {
    annotatedPath?: string;
  };
  outcome: 'success' | 'failure' | 'skipped' | 'blocked' | 'unknown';
  recovery?: {
    hintRule?: string;
    nextSuggestedTool?: string;
  };
  durationsMs: Record<string, number>;
  redaction: {
    inlineImages: false;
    secretsRedacted: true;
  };
}

export interface VisualTrajectoryRecordInput {
  enabled?: boolean;
  rootDir?: string;
  sessionId: string;
  tabId: string;
  url: string;
  toolName: string;
  instruction?: string;
  provider: string;
  elementCount: number;
  latencyMs?: number;
  warnings?: string[];
  outcome: VisualTrajectoryEntry['outcome'];
  annotatedImageBase64?: string;
  mimeType?: string;
}

export interface VisualTrajectoryRecordResult {
  traceId: string;
  dir: string;
  entryPath: string;
  annotatedPath?: string;
}

const DEFAULT_ROOT = path.join(os.homedir(), '.openchrome', 'trajectories', 'visual');

export function isVisualTrajectoryEnabled(explicit?: boolean): boolean {
  if (explicit === true) return true;
  const raw = process.env.OPENCHROME_VISUAL_TRAJECTORY;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function getVisualTrajectoryRoot(explicit?: string): string {
  return explicit || process.env.OPENCHROME_VISUAL_TRAJECTORY_DIR || DEFAULT_ROOT;
}

function newTraceId(): string {
  return `visual-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

function imageExtension(mimeType: string | undefined): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

export async function recordVisualTrajectory(input: VisualTrajectoryRecordInput): Promise<VisualTrajectoryRecordResult | null> {
  if (!isVisualTrajectoryEnabled(input.enabled)) return null;

  const traceId = newTraceId();
  const root = getVisualTrajectoryRoot(input.rootDir);
  const dir = path.join(root, traceId);
  await fs.promises.mkdir(dir, { recursive: true });

  let annotatedPath: string | undefined;
  if (input.annotatedImageBase64) {
    const filename = `annotated.${imageExtension(input.mimeType)}`;
    annotatedPath = path.join(dir, filename);
    await fs.promises.writeFile(annotatedPath, Buffer.from(input.annotatedImageBase64, 'base64'));
  }

  const entry: VisualTrajectoryEntry = {
    version: 1,
    traceId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    url: input.url,
    timestamp: Date.now(),
    toolName: input.toolName,
    ...(input.instruction ? { action: { kind: 'visual_query', target: input.instruction, strategy: 'vision_find' } } : {}),
    perception: {
      provider: input.provider,
      elementCount: input.elementCount,
      latencyMs: input.latencyMs,
      warnings: input.warnings || [],
    },
    ...(annotatedPath ? { screenshots: { annotatedPath } } : {}),
    outcome: input.outcome,
    durationsMs: input.latencyMs !== undefined ? { perception: input.latencyMs } : {},
    redaction: {
      inlineImages: false,
      secretsRedacted: true,
    },
  };
  const entryPath = path.join(dir, 'events.jsonl');
  await fs.promises.appendFile(entryPath, JSON.stringify(entry) + '\n');
  return { traceId, dir, entryPath, annotatedPath };
}
