/**
 * Screenshot-class registry on disk.
 *
 * Layout under `<rootDir>/<class_id>/`:
 *   - `exemplars/<n>.png`         raw exemplar PNG kept verbatim for re-teach
 *   - `exemplars/<n>.hash`        hex-encoded 64-bit pHash (cache)
 *   - `threshold.json`            { value, hash_bits: 64, exemplar_count }
 *
 * Default `<rootDir>` is `~/.openchrome/screenshot-classes/`; tests override
 * via `OPENCHROME_SCREENSHOT_CLASSES_DIR`.
 *
 * Threshold derivation (per spec): mean pairwise Hamming distance among
 * exemplars + 2σ, floored at 4 and capped at 16. With < 2 exemplars there
 * is no spread to measure, so we fall back to a conservative default.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import writeFileAtomic from 'write-file-atomic';

import { hamming, phashFromHex, phashFromPng, phashToHex } from './phash';

/**
 * Mode 0o600 — registry contents (raw screenshots, hashes, threshold) are
 * potentially identifying and should not be world-readable on shared hosts.
 */
const REGISTRY_FILE_MODE = 0o600;

const DEFAULT_THRESHOLD_FALLBACK = 8;
const THRESHOLD_FLOOR = 4;
const THRESHOLD_CEIL = 16;
/**
 * Class IDs must be safe path components — block traversal up front.
 * The character class allows dots, so reject `.` / `..` explicitly so a
 * caller can't `path.join(rootDir, '..')` themselves out of the registry.
 */
const VALID_CLASS_ID = /^[A-Za-z0-9._-]+$/;
const RESERVED_CLASS_IDS = new Set(['.', '..']);

export interface ScreenshotClassMetadata {
  classId: string;
  threshold: number;
  exemplarCount: number;
  hashBits: 64;
}

export interface LoadedScreenshotClass extends ScreenshotClassMetadata {
  exemplars: { name: string; hash: bigint }[];
}

export interface ScoreResult {
  /** Min Hamming distance to any exemplar (lower = closer). */
  distance: number;
  /** Exemplar name that produced the minimum. */
  exemplar: string;
  /** True iff distance ≤ threshold for this class. */
  passed: boolean;
  /** Threshold used in the comparison, returned for evidence. */
  threshold: number;
}

export function defaultClassesDir(): string {
  return (
    process.env.OPENCHROME_SCREENSHOT_CLASSES_DIR ||
    path.join(os.homedir(), '.openchrome', 'screenshot-classes')
  );
}

export function classDir(classId: string, rootDir: string = defaultClassesDir()): string {
  if (!VALID_CLASS_ID.test(classId) || RESERVED_CLASS_IDS.has(classId)) {
    throw new Error(
      `invalid class_id '${classId}' — must match ${VALID_CLASS_ID} and not be '.' or '..'`,
    );
  }
  return path.join(rootDir, classId);
}

/**
 * Add an exemplar PNG to a class. Recomputes and writes `threshold.json`
 * atomically. Returns updated metadata.
 */
export async function teachClass(
  classId: string,
  pngPath: string,
  rootDir: string = defaultClassesDir(),
): Promise<ScreenshotClassMetadata> {
  let png: Buffer;
  try {
    png = await fsp.readFile(pngPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`exemplar PNG not found: ${pngPath}`);
    }
    throw err;
  }
  // Compute hash up front so we fail loud on undecodable input before
  // mutating the registry.
  const hash = phashFromPng(png);

  const dir = classDir(classId, rootDir);
  const exemplarsDir = path.join(dir, 'exemplars');
  await fsp.mkdir(exemplarsDir, { recursive: true });

  // Reserve an exemplar slot atomically so concurrent teaches to the same
  // class don't pick the same index and clobber each other. We claim the
  // slot by O_EXCL-creating the .png first; on EEXIST we bump and retry.
  // Retries are bounded but generously sized (matches our hand-tuned cap
  // for "obviously broken filesystem"); each iteration only re-reads the
  // directory, no expensive work.
  const MAX_TEACH_RETRIES = 64;
  let baseName = '';
  for (let attempt = 0; attempt < MAX_TEACH_RETRIES; attempt++) {
    const existing = await listExemplarBaseNames(exemplarsDir);
    const idx = nextExemplarIndex(existing) + attempt;
    const candidateName = String(idx).padStart(4, '0');
    const candidatePath = path.join(exemplarsDir, `${candidateName}.png`);
    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(candidatePath, 'wx', REGISTRY_FILE_MODE);
      await fh.writeFile(png);
      baseName = candidateName;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      await fh?.close();
    }
  }
  if (!baseName) {
    throw new Error(
      `could not allocate exemplar slot for class '${classId}' after ${MAX_TEACH_RETRIES} attempts`,
    );
  }
  const hashTarget = path.join(exemplarsDir, `${baseName}.hash`);
  await writeFileAtomic(hashTarget, phashToHex(hash), { mode: REGISTRY_FILE_MODE });

  const loaded = await loadClass(classId, rootDir);
  const threshold = recommendThreshold(loaded.exemplars.map((e) => e.hash));
  const metadata: ScreenshotClassMetadata = {
    classId,
    threshold,
    exemplarCount: loaded.exemplars.length,
    hashBits: 64,
  };
  await writeFileAtomic(
    path.join(dir, 'threshold.json'),
    JSON.stringify({ value: threshold, hash_bits: 64, exemplar_count: metadata.exemplarCount }, null, 2) + '\n',
    { mode: REGISTRY_FILE_MODE },
  );
  return metadata;
}

/** Load a class from disk. Throws if the class directory does not exist. */
export async function loadClass(
  classId: string,
  rootDir: string = defaultClassesDir(),
): Promise<LoadedScreenshotClass> {
  const dir = classDir(classId, rootDir);
  if (!(await pathExists(dir))) {
    throw new Error(`screenshot class '${classId}' not found at ${dir}`);
  }

  const exemplarsDir = path.join(dir, 'exemplars');
  const exemplars: { name: string; hash: bigint }[] = [];
  if (await pathExists(exemplarsDir)) {
    const entries = (await fsp.readdir(exemplarsDir)).sort();
    const hashFiles = entries.filter((e) => e.endsWith('.hash'));
    const contents = await Promise.all(
      hashFiles.map((f) => fsp.readFile(path.join(exemplarsDir, f), 'utf8')),
    );
    for (let i = 0; i < hashFiles.length; i++) {
      const entry = hashFiles[i];
      const hashHex = contents[i].trim();
      try {
        exemplars.push({
          name: entry.slice(0, -'.hash'.length),
          hash: phashFromHex(hashHex),
        });
      } catch (err) {
        throw new Error(`corrupt exemplar hash '${entry}': ${(err as Error).message}`);
      }
    }
  }

  const thresholdPath = path.join(dir, 'threshold.json');
  let threshold: number;
  if (await pathExists(thresholdPath)) {
    const parsed = JSON.parse(await fsp.readFile(thresholdPath, 'utf8'));
    if (typeof parsed.value !== 'number' || !Number.isInteger(parsed.value) ||
        parsed.value < 0 || parsed.value > 64) {
      throw new Error(`invalid threshold.json for class '${classId}': value=${parsed.value}`);
    }
    threshold = parsed.value;
  } else {
    threshold = DEFAULT_THRESHOLD_FALLBACK;
  }

  return {
    classId,
    threshold,
    exemplarCount: exemplars.length,
    hashBits: 64,
    exemplars,
  };
}

/** Score a candidate hash against a class. */
export function scoreHash(
  loaded: LoadedScreenshotClass,
  candidate: bigint,
  overrideThreshold?: number,
): ScoreResult {
  if (loaded.exemplars.length === 0) {
    throw new Error(`cannot score against empty class '${loaded.classId}'`);
  }
  let bestDist = 65;
  let bestName = loaded.exemplars[0].name;
  for (const ex of loaded.exemplars) {
    const d = hamming(ex.hash, candidate);
    if (d < bestDist) {
      bestDist = d;
      bestName = ex.name;
    }
  }
  const threshold = overrideThreshold ?? loaded.threshold;
  return {
    distance: bestDist,
    exemplar: bestName,
    passed: bestDist <= threshold,
    threshold,
  };
}

/**
 * Compute the recommended threshold from a list of exemplar hashes:
 * mean pairwise Hamming + 2σ, floored at THRESHOLD_FLOOR and capped at
 * THRESHOLD_CEIL.
 */
export function recommendThreshold(hashes: bigint[]): number {
  if (hashes.length < 2) return DEFAULT_THRESHOLD_FALLBACK;
  const distances: number[] = [];
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      distances.push(hamming(hashes[i], hashes[j]));
    }
  }
  const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
  const variance =
    distances.reduce((s, d) => s + (d - mean) ** 2, 0) / distances.length;
  const sigma = Math.sqrt(variance);
  const recommended = Math.round(mean + 2 * sigma);
  return Math.min(THRESHOLD_CEIL, Math.max(THRESHOLD_FLOOR, recommended));
}

async function listExemplarBaseNames(exemplarsDir: string): Promise<string[]> {
  if (!(await pathExists(exemplarsDir))) return [];
  const entries = await fsp.readdir(exemplarsDir);
  return entries
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.slice(0, -'.png'.length));
}

function nextExemplarIndex(existing: string[]): number {
  let max = -1;
  for (const base of existing) {
    const n = parseInt(base, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
