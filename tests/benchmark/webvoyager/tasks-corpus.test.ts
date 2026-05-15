/// <reference types="jest" />

/**
 * Structural validation of the WebVoyager task corpus.
 *
 * The runner's loadTasks() filters tasks/*.ts purely by filename and only
 * checks `typeof t.name === 'string'` before use — so a malformed task spec
 * would slip through to a real run. This test loads every task file the same
 * way the runner does and asserts the full WebVoyagerTask shape, so a broken
 * spec fails fast in CI instead of mid-benchmark.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WebVoyagerTask } from './types';

const TASKS_DIR = path.join(__dirname, 'tasks');

function taskFiles(): string[] {
  // Mirror runner.ts loadTasks() filtering exactly.
  return fs
    .readdirSync(TASKS_DIR)
    .filter((e) => e.endsWith('.ts') && !e.startsWith('_') && e !== 'README.md')
    .sort();
}

function isAssertion(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  if (typeof a.kind !== 'string') return false;
  if (a.kind === 'and' || a.kind === 'or') {
    return Array.isArray(a.children) && a.children.every(isAssertion);
  }
  return true; // leaf assertion — kind-specific fields are checked by the contract DSL itself
}

describe('WebVoyager task corpus', () => {
  const files = taskFiles();

  test('the corpus has expanded beyond the original 10 tasks', () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  test.each(files)('%s exports a structurally valid WebVoyagerTask', async (file) => {
    const mod = await import(path.join(TASKS_DIR, file));
    const task = (mod.default ?? mod.task) as WebVoyagerTask | undefined;

    expect(task).toBeDefined();
    expect(typeof task!.name).toBe('string');
    expect(task!.name.length).toBeGreaterThan(0);
    // The runner sorts by filename and keys reports by name — they must agree.
    expect(file).toBe(`${task!.name}.ts`);
    expect(typeof task!.instruction).toBe('string');
    expect(task!.instruction.length).toBeGreaterThan(0);
    expect(typeof task!.timeout_ms).toBe('number');
    expect(task!.timeout_ms).toBeGreaterThan(0);
    expect(task!.contract).toBeDefined();
    expect(isAssertion(task!.contract.postconditions)).toBe(true);
  });

  test('task names are unique across the corpus', async () => {
    const names = await Promise.all(
      files.map(async (f) => {
        const mod = await import(path.join(TASKS_DIR, f));
        return ((mod.default ?? mod.task) as WebVoyagerTask).name;
      }),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  test('newly added tasks (task-11..task-18) are marked pending until transcripts exist', async () => {
    const newFiles = files.filter((f) => /^task-1[1-8]-/.test(f));
    expect(newFiles.length).toBe(8);
    for (const f of newFiles) {
      const mod = await import(path.join(TASKS_DIR, f));
      const task = (mod.default ?? mod.task) as WebVoyagerTask;
      // Honest flag: no frozen transcript recorded yet, so the mock runner
      // must skip them rather than report a false pass/fail.
      expect(task.pending).toBe(true);
    }
  });

  test('Sprint-2 corpus expansion (task-19..) is also marked pending', async () => {
    // The 43 tasks added in Sprint 2 (#1257 — PR-11) all ship pending until
    // their transcripts are recorded in the next-session real-LLM run. This
    // is the same honesty guard as the task-11..18 batch — without it, a
    // task could silently default to `pending: false` and the mock runner
    // would report a false pass/fail for a task that has no ground truth.
    const sprint2Files = files.filter((f) => {
      const match = /^task-(\d+)-/.exec(f);
      if (!match) return false;
      return parseInt(match[1], 10) >= 19;
    });
    expect(sprint2Files.length).toBeGreaterThanOrEqual(40);
    for (const f of sprint2Files) {
      const mod = await import(path.join(TASKS_DIR, f));
      const task = (mod.default ?? mod.task) as WebVoyagerTask;
      expect(task.pending).toBe(true);
    }
  });
});
