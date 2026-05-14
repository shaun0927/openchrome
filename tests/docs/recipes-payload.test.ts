/// <reference types="jest" />

import * as fs from 'fs';
import * as path from 'path';

const recipeDir = path.join(__dirname, '../../docs/recipes');
const recipeFiles = [
  'topic-survey.md',
  'single-page-deep-extract.md',
  'changelog-watch.md',
];

function extractJsonBlocks(markdown: string): string[] {
  return Array.from(markdown.matchAll(/```json\s*([\s\S]*?)\s*```/g), match => match[1]);
}

describe('research recipe batch_execute payloads', () => {
  test.each(recipeFiles)('%s contains parseable batch_execute JSON', (file) => {
    const markdown = fs.readFileSync(path.join(recipeDir, file), 'utf8');
    const blocks = extractJsonBlocks(markdown);
    expect(blocks).toHaveLength(1);

    const payload = JSON.parse(blocks[0]) as {
      tasks?: Array<{ tabId?: string; script?: string }>;
      concurrency?: number;
      failFast?: boolean;
    };
    expect(Array.isArray(payload.tasks)).toBe(true);
    expect(payload.tasks?.length).toBeGreaterThan(0);
    expect(payload.concurrency).toBe(1);
    expect(payload.failFast).toBe(true);
    for (const task of payload.tasks ?? []) {
      expect(task.tabId).toBe('active-tab-id');
      expect(typeof task.script).toBe('string');
      expect(task.script).toContain('return');
    }
  });
});
