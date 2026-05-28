/// <reference types="jest" />

/**
 * Unit tests for the Online-Mind2Web dataset loader.
 *
 * - Fixture happy path: loads sample-10.json, validates all 10 tasks conform to schema.
 * - Schema rejection: malformed tasks produce a clear error.
 * - HF fetch path: skipped unless OPENCHROME_OM2W_FETCH=1 is set, to keep CI deterministic.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadOnlineMind2Web, OnlineMind2WebTask } from './loader';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-10.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidTask(task: unknown): task is OnlineMind2WebTask {
  if (task === null || typeof task !== 'object') return false;
  const t = task as Record<string, unknown>;
  return (
    typeof t.task_id === 'string' &&
    t.task_id.trim() !== '' &&
    typeof t.website === 'string' &&
    t.website.trim() !== '' &&
    typeof t.task_description === 'string' &&
    t.task_description.trim() !== '' &&
    typeof t.reference_length === 'number' &&
    Number.isInteger(t.reference_length) &&
    t.reference_length >= 0
  );
}

// ---------------------------------------------------------------------------
// Fixture happy path
// ---------------------------------------------------------------------------

describe('loadOnlineMind2Web — fixture mode', () => {
  test('fixture file exists at expected path', () => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
  });

  test('returns exactly 10 tasks', async () => {
    const tasks = await loadOnlineMind2Web({ source: 'fixture' });
    expect(tasks).toHaveLength(10);
  });

  test('every task conforms to OnlineMind2WebTask schema', async () => {
    const tasks = await loadOnlineMind2Web({ source: 'fixture' });
    for (const task of tasks) {
      expect(isValidTask(task)).toBe(true);
    }
  });

  test('task_ids are unique', async () => {
    const tasks = await loadOnlineMind2Web({ source: 'fixture' });
    const ids = tasks.map((t) => t.task_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('all task_ids are non-empty strings', async () => {
    const tasks = await loadOnlineMind2Web({ source: 'fixture' });
    for (const task of tasks) {
      expect(typeof task.task_id).toBe('string');
      expect(task.task_id.trim()).not.toBe('');
    }
  });

  test('all websites are non-empty strings', async () => {
    const tasks = await loadOnlineMind2Web({ source: 'fixture' });
    for (const task of tasks) {
      expect(typeof task.website).toBe('string');
      expect(task.website.trim()).not.toBe('');
    }
  });

  test('all task_descriptions are non-empty strings', async () => {
    const tasks = await loadOnlineMind2Web({ source: 'fixture' });
    for (const task of tasks) {
      expect(typeof task.task_description).toBe('string');
      expect(task.task_description.trim()).not.toBe('');
    }
  });

  test('all reference_lengths are non-negative integers', async () => {
    const tasks = await loadOnlineMind2Web({ source: 'fixture' });
    for (const task of tasks) {
      expect(typeof task.reference_length).toBe('number');
      expect(Number.isInteger(task.reference_length)).toBe(true);
      expect(task.reference_length).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema rejection — malformed tasks throw clear errors
// ---------------------------------------------------------------------------

describe('loadOnlineMind2Web — schema validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om2w-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Schema validation is exercised via the HF cache path (pre-seeded with
  // malformed data), since the fixture path is hard-coded to sample-10.json.

  test('missing task_id throws with clear message', async () => {
    const badTask = {
      // task_id intentionally absent
      website: 'https://example.com',
      task_description: 'do something',
      reference_length: 2,
    };

    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'online-mind2web-v1.json'),
      JSON.stringify([badTask]),
      'utf8',
    );

    const origEnv = process.env.OPENCHROME_OM2W_FETCH;
    process.env.OPENCHROME_OM2W_FETCH = '1';
    try {
      await expect(loadOnlineMind2Web({ source: 'hf', cacheDir })).rejects.toThrow(
        /task_id/,
      );
    } finally {
      if (origEnv === undefined) delete process.env.OPENCHROME_OM2W_FETCH;
      else process.env.OPENCHROME_OM2W_FETCH = origEnv;
    }
  });

  test('missing website throws with clear message', async () => {
    const badTask = {
      task_id: 'om2w-bad-001',
      // website intentionally absent
      task_description: 'do something',
      reference_length: 2,
    };

    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'online-mind2web-v1.json'),
      JSON.stringify([badTask]),
      'utf8',
    );

    const origEnv = process.env.OPENCHROME_OM2W_FETCH;
    process.env.OPENCHROME_OM2W_FETCH = '1';
    try {
      await expect(loadOnlineMind2Web({ source: 'hf', cacheDir })).rejects.toThrow(
        /website/,
      );
    } finally {
      if (origEnv === undefined) delete process.env.OPENCHROME_OM2W_FETCH;
      else process.env.OPENCHROME_OM2W_FETCH = origEnv;
    }
  });

  test('non-integer reference_length throws with clear message', async () => {
    const badTask = {
      task_id: 'om2w-bad-002',
      website: 'https://example.com',
      task_description: 'do something',
      reference_length: 'not-a-number',
    };

    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'online-mind2web-v1.json'),
      JSON.stringify([badTask]),
      'utf8',
    );

    const origEnv = process.env.OPENCHROME_OM2W_FETCH;
    process.env.OPENCHROME_OM2W_FETCH = '1';
    try {
      await expect(loadOnlineMind2Web({ source: 'hf', cacheDir })).rejects.toThrow(
        /reference_length/,
      );
    } finally {
      if (origEnv === undefined) delete process.env.OPENCHROME_OM2W_FETCH;
      else process.env.OPENCHROME_OM2W_FETCH = origEnv;
    }
  });

  test('non-array input throws with clear message', async () => {
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'online-mind2web-v1.json'),
      JSON.stringify({ not: 'an array' }),
      'utf8',
    );

    const origEnv = process.env.OPENCHROME_OM2W_FETCH;
    process.env.OPENCHROME_OM2W_FETCH = '1';
    try {
      await expect(loadOnlineMind2Web({ source: 'hf', cacheDir })).rejects.toThrow(
        /expected a JSON array/i,
      );
    } finally {
      if (origEnv === undefined) delete process.env.OPENCHROME_OM2W_FETCH;
      else process.env.OPENCHROME_OM2W_FETCH = origEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// HF fetch path — skipped unless OPENCHROME_OM2W_FETCH=1
// ---------------------------------------------------------------------------

describe('loadOnlineMind2Web — HF fetch path', () => {
  const HF_FETCH_ENABLED = process.env.OPENCHROME_OM2W_FETCH === '1';

  (HF_FETCH_ENABLED ? test : test.skip)(
    'fetches and returns tasks from HuggingFace (requires network + OPENCHROME_OM2W_FETCH=1)',
    async () => {
      const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om2w-hf-cache-'));
      try {
        const tasks = await loadOnlineMind2Web({ source: 'hf', cacheDir: tmpCacheDir });
        expect(Array.isArray(tasks)).toBe(true);
        expect(tasks.length).toBeGreaterThan(0);
        for (const task of tasks) {
          expect(isValidTask(task)).toBe(true);
        }
        // Cache file should now exist.
        const cachePath = path.join(tmpCacheDir, 'online-mind2web-v1.json');
        expect(fs.existsSync(cachePath)).toBe(true);
      } finally {
        fs.rmSync(tmpCacheDir, { recursive: true, force: true });
      }
    },
    60000, // 60s timeout for network fetch
  );

  test('throws if OPENCHROME_OM2W_FETCH is not set', async () => {
    const origEnv = process.env.OPENCHROME_OM2W_FETCH;
    delete process.env.OPENCHROME_OM2W_FETCH;
    try {
      await expect(loadOnlineMind2Web({ source: 'hf' })).rejects.toThrow(
        /OPENCHROME_OM2W_FETCH/,
      );
    } finally {
      if (origEnv !== undefined) process.env.OPENCHROME_OM2W_FETCH = origEnv;
    }
  });

  test('serves from local cache on second call without re-fetching', async () => {
    const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om2w-cache-test-'));
    try {
      // Pre-seed a minimal valid cache.
      const cachedTasks: OnlineMind2WebTask[] = [
        {
          task_id: 'om2w-cached-001',
          website: 'https://example.com',
          task_description: 'cached task',
          reference_length: 1,
        },
      ];
      fs.writeFileSync(
        path.join(tmpCacheDir, 'online-mind2web-v1.json'),
        JSON.stringify(cachedTasks),
        'utf8',
      );

      const origEnv = process.env.OPENCHROME_OM2W_FETCH;
      process.env.OPENCHROME_OM2W_FETCH = '1';
      try {
        const tasks = await loadOnlineMind2Web({ source: 'hf', cacheDir: tmpCacheDir });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].task_id).toBe('om2w-cached-001');
      } finally {
        if (origEnv === undefined) delete process.env.OPENCHROME_OM2W_FETCH;
        else process.env.OPENCHROME_OM2W_FETCH = origEnv;
      }
    } finally {
      fs.rmSync(tmpCacheDir, { recursive: true, force: true });
    }
  });
});
