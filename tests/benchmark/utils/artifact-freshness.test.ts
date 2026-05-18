/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  auditBenchmarkResultArtifactFreshness,
  findOpenChromeVersionPins,
} from './artifact-freshness';

describe('benchmark artifact freshness audit', () => {
  test('finds OpenChrome version pins in common result shapes', () => {
    expect(findOpenChromeVersionPins({
      competitors: [{ name: 'openchrome', version: '1.12.2' }],
      results: [{ library: 'OpenChrome', version: '1.12.4' }],
    })).toEqual(['1.12.2', '1.12.4']);
  });

  test('reports stale OpenChrome pins without treating dependency versions as stale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bench-results-'));
    fs.writeFileSync(path.join(dir, 'stale.json'), JSON.stringify({
      competitors: [
        { name: 'openchrome', version: '1.12.2' },
        { name: 'playwright', version: '1.49.0' },
      ],
    }));
    fs.writeFileSync(path.join(dir, 'fresh.json'), JSON.stringify({
      competitors: [{ name: 'OpenChrome', version: '1.12.4' }],
    }));

    expect(auditBenchmarkResultArtifactFreshness(dir, '1.12.4')).toEqual([
      {
        file: path.relative(process.cwd(), path.join(dir, 'stale.json')),
        expectedOpenChromeVersion: '1.12.4',
        foundVersions: ['1.12.2'],
      },
    ]);
  });
});
