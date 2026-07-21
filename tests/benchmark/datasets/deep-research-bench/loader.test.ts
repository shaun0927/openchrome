/**
 * DeepResearch Bench loader tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadDeepResearchTasks } from './loader';

describe('loadDeepResearchTasks', () => {
  it('loads the fixture and returns 8 well-shaped tasks', () => {
    const tasks = loadDeepResearchTasks({ source: 'fixture' });
    expect(tasks.length).toBe(8);
    for (const t of tasks) {
      expect(typeof t.task_id).toBe('string');
      expect(['en', 'zh']).toContain(t.language);
      expect(t.expected_sources.length).toBeGreaterThan(0);
      expect(t.reference_steps).toBeGreaterThan(0);
    }
  });

  it('filters by language', () => {
    const en = loadDeepResearchTasks({ source: 'fixture', language: 'en' });
    const zh = loadDeepResearchTasks({ source: 'fixture', language: 'zh' });
    expect(en.every((t) => t.language === 'en')).toBe(true);
    expect(zh.every((t) => t.language === 'zh')).toBe(true);
    expect(en.length + zh.length).toBe(8);
  });

  it('filters by domain (case-insensitive)', () => {
    const sci = loadDeepResearchTasks({ source: 'fixture', domain: 'science' });
    expect(sci.every((t) => t.domain.toLowerCase() === 'science')).toBe(true);
  });

  it('honours the limit', () => {
    const three = loadDeepResearchTasks({ source: 'fixture', limit: 3 });
    expect(three.length).toBe(3);
  });

  it('loads from an arbitrary file', () => {
    const tmp = path.join(os.tmpdir(), `drb-${Date.now()}.json`);
    fs.writeFileSync(
      tmp,
      JSON.stringify([
        {
          task_id: 'x',
          language: 'en',
          domain: 'Test',
          query: 'q',
          expected_sources: ['https://a.com'],
          reference_steps: 1,
        },
      ]),
    );
    try {
      const tasks = loadDeepResearchTasks({ source: 'file', filePath: tmp });
      expect(tasks.length).toBe(1);
      expect(tasks[0].task_id).toBe('x');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('throws when file source is missing filePath', () => {
    expect(() => loadDeepResearchTasks({ source: 'file' })).toThrow(/filePath/);
  });

  it('rejects malformed tasks', () => {
    const tmp = path.join(os.tmpdir(), `drb-bad-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify([{ task_id: 'x' }]));
    try {
      expect(() => loadDeepResearchTasks({ source: 'file', filePath: tmp })).toThrow();
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
