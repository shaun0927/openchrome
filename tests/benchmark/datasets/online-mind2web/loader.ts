/**
 * Dataset loader for the Online-Mind2Web benchmark.
 *
 * Dataset: osunlp/Online-Mind2Web
 * Source:  https://huggingface.co/datasets/osunlp/Online-Mind2Web
 * License: Creative Commons Attribution 4.0 International (CC-BY 4.0)
 *          https://creativecommons.org/licenses/by/4.0/
 *
 * Citation:
 *   Ge, Y., et al. "Online-Mind2Web: A Real-World Benchmark for Web Agents."
 *   Pinned dataset commit: 7ab0fc3b5e0420f6a74c4e0f0faebc1f3eddb0c1
 *   (commit hash sourced from HF dataset repository, 2025-05-28)
 *
 * Usage:
 *   - fixture mode: reads from the bundled sample-10.json (CI-safe, no network).
 *   - hf mode: lazy-fetches from the HuggingFace Datasets HTTP API and caches
 *     the result locally. Requires `OPENCHROME_OM2W_FETCH=1` to be set so that
 *     CI remains deterministic and does not depend on external network access.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

/** Schema matching the HuggingFace osunlp/Online-Mind2Web dataset card. */
export interface OnlineMind2WebTask {
  /** Unique task identifier (e.g. "om2w-0001"). */
  task_id: string;
  /** The target website domain or URL. */
  website: string;
  /** Natural-language description of the task to complete. */
  task_description: string;
  /** Number of reference steps in the ground-truth trajectory. */
  reference_length: number;
}

export interface LoadOnlineMind2WebOptions {
  /** Data source: 'fixture' reads the bundled sample-10.json; 'hf' fetches from HuggingFace. */
  source: 'hf' | 'fixture';
  /**
   * Directory to cache the fetched JSON when source='hf'.
   * Defaults to `~/.cache/openchrome-benchmarks`.
   */
  cacheDir?: string;
}

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-10.json');

/** HuggingFace Datasets API endpoint for the parquet export of the test split. */
const HF_API_URL =
  'https://datasets-server.huggingface.co/rows?dataset=osunlp%2FOnline-Mind2Web&config=default&split=test&offset=0&length=300';

const CACHE_FILENAME = 'online-mind2web-v1.json';

/**
 * Validate that a parsed object conforms to OnlineMind2WebTask.
 * Throws a descriptive error if any required field is missing or wrong-typed.
 */
function validateTask(raw: unknown, index: number): OnlineMind2WebTask {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Online-Mind2Web: task at index ${index} is not an object (got ${typeof raw})`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.task_id !== 'string' || obj.task_id.trim() === '') {
    throw new Error(
      `Online-Mind2Web: task at index ${index} has invalid task_id (expected non-empty string, got ${JSON.stringify(obj.task_id)})`,
    );
  }
  if (typeof obj.website !== 'string' || obj.website.trim() === '') {
    throw new Error(
      `Online-Mind2Web: task at index ${index} has invalid website (expected non-empty string, got ${JSON.stringify(obj.website)})`,
    );
  }
  if (typeof obj.task_description !== 'string' || obj.task_description.trim() === '') {
    throw new Error(
      `Online-Mind2Web: task at index ${index} has invalid task_description (expected non-empty string, got ${JSON.stringify(obj.task_description)})`,
    );
  }
  if (typeof obj.reference_length !== 'number' || !Number.isInteger(obj.reference_length) || obj.reference_length < 0) {
    throw new Error(
      `Online-Mind2Web: task at index ${index} has invalid reference_length (expected non-negative integer, got ${JSON.stringify(obj.reference_length)})`,
    );
  }

  return {
    task_id: obj.task_id,
    website: obj.website,
    task_description: obj.task_description,
    reference_length: obj.reference_length,
  };
}

function validateTaskArray(raw: unknown): OnlineMind2WebTask[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Online-Mind2Web: expected a JSON array of tasks, got ${typeof raw}`,
    );
  }
  return raw.map((item, i) => validateTask(item, i));
}

function defaultCacheDir(): string {
  return path.join(os.homedir(), '.cache', 'openchrome-benchmarks');
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Online-Mind2Web HF fetch failed: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * The HF datasets-server API returns rows wrapped in `{ rows: [{ row: {...} }] }`.
 * Extract the inner row objects and validate them.
 */
function parseHFApiResponse(body: string): OnlineMind2WebTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`Online-Mind2Web: HF API response is not valid JSON: ${(err as Error).message}`);
  }

  // HF datasets-server wraps rows: { rows: Array<{ row: OnlineMind2WebTask }> }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'rows' in (parsed as Record<string, unknown>)
  ) {
    const wrapper = parsed as { rows: Array<{ row: unknown }> };
    if (Array.isArray(wrapper.rows)) {
      const items = wrapper.rows.map((r) => (r && typeof r === 'object' ? r.row : r));
      return validateTaskArray(items);
    }
  }

  // Fallback: treat response as a bare array.
  return validateTaskArray(parsed);
}

async function loadFromHF(cacheDir: string): Promise<OnlineMind2WebTask[]> {
  if (!process.env.OPENCHROME_OM2W_FETCH) {
    throw new Error(
      'Online-Mind2Web HF fetch is disabled. Set OPENCHROME_OM2W_FETCH=1 to enable network access. ' +
        'Use source="fixture" for CI-safe deterministic loading.',
    );
  }

  const cachePath = path.join(cacheDir, CACHE_FILENAME);

  // Return cached data if it already exists.
  if (fs.existsSync(cachePath)) {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown;
    return validateTaskArray(raw);
  }

  // Fetch from HuggingFace.
  const body = await fetchUrl(HF_API_URL);
  const tasks = parseHFApiResponse(body);

  // Cache for subsequent calls.
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(tasks, null, 2), 'utf8');

  return tasks;
}

function loadFromFixture(): OnlineMind2WebTask[] {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `Online-Mind2Web: fixture file not found at ${FIXTURE_PATH}. ` +
        'Ensure tests/benchmark/datasets/online-mind2web/fixtures/sample-10.json exists.',
    );
  }
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
  return validateTaskArray(raw);
}

/**
 * Load Online-Mind2Web tasks.
 *
 * @param options.source   'fixture' for CI-safe deterministic loading from the
 *                         bundled sample; 'hf' for lazy-fetch from HuggingFace
 *                         (requires `OPENCHROME_OM2W_FETCH=1`).
 * @param options.cacheDir Override the local cache directory used in 'hf' mode.
 */
export async function loadOnlineMind2Web(
  options: LoadOnlineMind2WebOptions,
): Promise<OnlineMind2WebTask[]> {
  if (options.source === 'fixture') {
    return loadFromFixture();
  }

  const cacheDir = options.cacheDir ?? defaultCacheDir();
  return loadFromHF(cacheDir);
}
