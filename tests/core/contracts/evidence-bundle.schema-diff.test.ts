/// <reference types="jest" />

/**
 * Tests for the schema_diff part of writeEvidenceBundle (B1-PR2 of #1359).
 *
 * Confirms:
 *  - schema_diff.json is written only when all preconditions hold;
 *  - the on-disk payload is the canonical diff plus the schema version;
 *  - the returned `schema_diff` mirrors the on-disk file;
 *  - the rest of the bundle behavior is unchanged.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeEvidenceBundle } from '../../../src/core/contracts/evidence-bundle';
import type { SchemaDefinition } from '../../../src/core/contracts/schema-diff';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bundle-schema-diff-'));
}

const schema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'title', type: 'string' },
    { name: 'statusCode', type: 'number' },
    { name: 'preview', type: 'string', required: false },
  ],
};

describe('writeEvidenceBundle — schema_diff part', () => {
  test('writes schema_diff.json when targetSchema + observed + include are all present', () => {
    const rootDir = tmpRoot();

    const result = writeEvidenceBundle(
      { observed: { title: 'Example', statusCode: 200 } },
      {
        rootDir,
        include: ['schema_diff'],
        targetSchema: schema,
      },
    );

    expect(result.parts).toContain('schema_diff.json');
    expect(result.schema_diff).toBeDefined();
    expect(result.schema_diff?.matched).toEqual(['title', 'statusCode']);
    expect(result.schema_diff?.missing).toEqual([]);
    expect(result.schema_diff?.coverage).toBe(1);

    // On-disk file matches the in-memory diff.
    const diskPayload = JSON.parse(
      fs.readFileSync(path.join(result.path, 'schema_diff.json'), 'utf8'),
    );
    expect(diskPayload.target_schema_version).toBe(1);
    expect(diskPayload.diff).toEqual(result.schema_diff);
  });

  test('records missing fields and partial coverage', () => {
    const rootDir = tmpRoot();

    const result = writeEvidenceBundle(
      { observed: { title: 'only-title' } },
      {
        rootDir,
        include: ['schema_diff'],
        targetSchema: schema,
      },
    );

    expect(result.schema_diff?.matched).toEqual(['title']);
    expect(result.schema_diff?.missing).toEqual(['statusCode']);
    expect(result.schema_diff?.coverage).toBe(0.5);
  });

  test('omitted when target_schema is absent', () => {
    const rootDir = tmpRoot();

    const result = writeEvidenceBundle(
      { observed: { title: 'whatever' } },
      { rootDir, include: ['schema_diff'] },
    );

    expect(result.parts).not.toContain('schema_diff.json');
    expect(result.schema_diff).toBeUndefined();
  });

  test('omitted when observed is absent', () => {
    const rootDir = tmpRoot();

    const result = writeEvidenceBundle(
      {},
      { rootDir, include: ['schema_diff'], targetSchema: schema },
    );

    expect(result.parts).not.toContain('schema_diff.json');
    expect(result.schema_diff).toBeUndefined();
  });

  test('omitted when schema_diff is not in the include set', () => {
    const rootDir = tmpRoot();

    const result = writeEvidenceBundle(
      { observed: { title: 'whatever' } },
      { rootDir, include: ['dom'], targetSchema: schema },
    );

    expect(result.parts).not.toContain('schema_diff.json');
    expect(result.schema_diff).toBeUndefined();
  });

  test('schema_diff can coexist with other parts', () => {
    const rootDir = tmpRoot();

    const result = writeEvidenceBundle(
      { dom: '<html></html>', observed: { title: 'x', statusCode: 200 } },
      {
        rootDir,
        include: ['dom', 'schema_diff'],
        targetSchema: schema,
      },
    );

    expect(result.parts).toEqual(['dom.json', 'schema_diff.json']);
    expect(result.schema_diff).toBeDefined();
  });
});
