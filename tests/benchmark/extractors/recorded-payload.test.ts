/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { liveOnlyExtractors } from './live-only';
import { recordedPayloadPath } from './recorded-payload';

describe('recorded token payload ingestion', () => {
  const oldEnv = process.env.OPENCHROME_BENCH_RECORDED_TOKENS_DIR;

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.OPENCHROME_BENCH_RECORDED_TOKENS_DIR;
    else process.env.OPENCHROME_BENCH_RECORDED_TOKENS_DIR = oldEnv;
  });

  test('lets live-only extractors use operator-recorded payloads without live runtime', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-recordings-'));
    const extractor = liveOnlyExtractors[0];
    process.env.OPENCHROME_BENCH_RECORDED_TOKENS_DIR = dir;
    fs.writeFileSync(recordedPayloadPath(dir, extractor.library, 'fixture-a'), JSON.stringify({
      payload: 'recorded payload',
      extracted: { title: 'Recorded' },
      evidence: { source: 'recorded-live', capturedAt: '2026-05-17T00:00:00.000Z', libraryVersion: '1.0.0' },
    }));

    const result = extractor.extract({
      html: '<html></html>',
      fixtureName: 'fixture-a',
      archetype: 'test',
      groundTruth: { fixture: 'fixture-a', fields: [{ key: 'title', expected: 'Recorded' }] },
      liveAllowed: false,
    });

    expect(result).toEqual({ payload: 'recorded payload', extracted: { title: 'Recorded' } });
  });
});
