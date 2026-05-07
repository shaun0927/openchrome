/**
 * Screenshot class registry — maps a stable `class_id` to a set of
 * exemplar 64-bit perceptual hashes plus a recommended distance
 * threshold.
 *
 * Layout:
 *   ~/.openchrome/screenshot-classes/<class_id>/
 *     ├── exemplars/
 *     │     ├── 1.png            (operator-supplied originals)
 *     │     ├── 2.png
 *     │     └── ...
 *     ├── exemplars.json         ({hashes: [hex, hex, …]})
 *     └── threshold.json         ({value: int, hash_bits: 64,
 *                                  exemplar_count: int})
 *
 * `class_id` is a slash-segmented identifier (e.g.
 * `order-confirmation/v3`) — segments map directly to subdirectories
 * so versions live side-by-side.
 *
 * The registry is read-mostly: load() returns a frozen snapshot for
 * the lifetime of one assertion eval. Write paths (teach()) are CLI-
 * driven and rare.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  hammingDistanceHex,
  phashFromRgba,
  type PhashResult,
} from './phash';

export const HASH_BITS = 64;

export interface ScreenshotClassThreshold {
  value: number;
  hash_bits: 64;
  exemplar_count: number;
}

export interface ScreenshotClassRecord {
  class_id: string;
  exemplars: string[]; // hex hashes
  threshold: ScreenshotClassThreshold;
}

export interface ScreenshotClassRegistryOptions {
  rootDir?: string;
}

export function defaultScreenshotClassRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'screenshot-classes');
}

/** Validate + normalize a class_id. Throws on invalid input. */
export function normalizeClassId(raw: string): string {
  if (!raw || typeof raw !== 'string') throw new Error('class_id must be a non-empty string');
  // Path-traversal: any "..", any backslash. Leading/trailing slashes
  // are normalized below — they're a formatting concern, not traversal.
  if (raw.includes('..') || raw.includes('\\')) {
    throw new Error(`class_id "${raw}" contains illegal path traversal`);
  }
  // Strip surrounding slashes and collapse repeated slashes.
  const normalized = raw.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  if (!/^[A-Za-z0-9._\-/]+$/.test(normalized)) {
    throw new Error(`class_id "${raw}" must match [A-Za-z0-9._\\-/]+`);
  }
  return normalized;
}

function classDir(rootDir: string, classId: string): string {
  return path.join(rootDir, normalizeClassId(classId));
}

export class ScreenshotClassRegistry {
  private readonly rootDir: string;

  constructor(opts: ScreenshotClassRegistryOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultScreenshotClassRootDir();
  }

  /** True iff a class_id has been taught at least once. */
  exists(classId: string): boolean {
    const dir = classDir(this.rootDir, classId);
    return fs.existsSync(path.join(dir, 'exemplars.json'));
  }

  /** Read a frozen snapshot. Returns null when class_id is unknown. */
  load(classId: string): ScreenshotClassRecord | null {
    const dir = classDir(this.rootDir, classId);
    const exPath = path.join(dir, 'exemplars.json');
    const thPath = path.join(dir, 'threshold.json');
    if (!fs.existsSync(exPath)) return null;
    let exemplars: string[];
    try {
      const parsed = JSON.parse(fs.readFileSync(exPath, 'utf8')) as { hashes?: unknown };
      exemplars = Array.isArray(parsed.hashes)
        ? parsed.hashes.filter((h): h is string => typeof h === 'string')
        : [];
    } catch {
      return null;
    }
    let threshold: ScreenshotClassThreshold;
    try {
      const parsed = JSON.parse(fs.readFileSync(thPath, 'utf8')) as Partial<ScreenshotClassThreshold>;
      threshold = {
        value: typeof parsed.value === 'number' ? parsed.value : recommendThreshold(exemplars),
        hash_bits: 64,
        exemplar_count: exemplars.length,
      };
    } catch {
      threshold = {
        value: recommendThreshold(exemplars),
        hash_bits: 64,
        exemplar_count: exemplars.length,
      };
    }
    return { class_id: normalizeClassId(classId), exemplars, threshold };
  }

  /**
   * Add an exemplar to a class. The exemplar may be supplied as raw
   * RGBA pixels (preferred — no decoder dependency) or as a pre-
   * computed PhashResult. PNG decoding is intentionally out of scope
   * here; CLI callers should decode and pass `rgba` + dimensions.
   */
  teach(args: {
    classId: string;
    rgba?: Uint8Array | Buffer;
    width?: number;
    height?: number;
    precomputed?: PhashResult;
  }): ScreenshotClassRecord {
    const cls = normalizeClassId(args.classId);
    const dir = classDir(this.rootDir, cls);
    fs.mkdirSync(dir, { recursive: true });

    let result: PhashResult;
    if (args.precomputed) {
      result = args.precomputed;
    } else if (args.rgba && args.width && args.height) {
      result = phashFromRgba(args.rgba, args.width, args.height);
    } else {
      throw new Error('teach() requires either precomputed PhashResult or rgba+width+height');
    }

    const existing = this.load(cls);
    const merged = existing ? [...existing.exemplars, result.hex] : [result.hex];
    const dedup = [...new Set(merged)];
    fs.writeFileSync(
      path.join(dir, 'exemplars.json'),
      JSON.stringify({ hashes: dedup }, null, 2),
      'utf8',
    );
    const threshold: ScreenshotClassThreshold = {
      value: recommendThreshold(dedup),
      hash_bits: 64,
      exemplar_count: dedup.length,
    };
    fs.writeFileSync(
      path.join(dir, 'threshold.json'),
      JSON.stringify(threshold, null, 2),
      'utf8',
    );
    return { class_id: cls, exemplars: dedup, threshold };
  }

  /**
   * Find the minimum Hamming distance between `candidateHex` and any
   * exemplar in the class. Returns Infinity for an empty class.
   */
  match(classId: string, candidateHex: string): { distance: number; closestHex?: string } {
    const rec = this.load(classId);
    if (!rec) return { distance: Number.POSITIVE_INFINITY };
    let best = Number.POSITIVE_INFINITY;
    let closest: string | undefined;
    for (const ex of rec.exemplars) {
      const d = hammingDistanceHex(ex, candidateHex);
      if (d < best) {
        best = d;
        closest = ex;
      }
    }
    return { distance: best, closestHex: closest };
  }
}

/**
 * Recommend a threshold given a set of exemplars. The pairwise mean
 * distance + 2σ heuristic from #705 v2, capped at 16 to keep matches
 * meaningful (16/64 ≈ 25 % of bits differ — beyond that, the images
 * are unrelated).
 */
export function recommendThreshold(exemplarHexes: string[]): number {
  if (exemplarHexes.length < 2) {
    // Single exemplar — pick a conservative default.
    return 8;
  }
  const distances: number[] = [];
  for (let i = 0; i < exemplarHexes.length; i++) {
    for (let j = i + 1; j < exemplarHexes.length; j++) {
      distances.push(hammingDistanceHex(exemplarHexes[i], exemplarHexes[j]));
    }
  }
  const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
  const variance =
    distances.reduce((s, d) => s + (d - mean) * (d - mean), 0) / distances.length;
  const sigma = Math.sqrt(variance);
  const recommended = Math.round(mean + 2 * sigma);
  return Math.max(2, Math.min(16, recommended));
}
