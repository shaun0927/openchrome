/// <reference types="jest" />

/**
 * MCP surface tests for the `target_schema` input on `oc_evidence_bundle`
 * (B1-PR2 of #1359).
 *
 * Confirms:
 *  - `args.target_schema` together with `evidence.snapshot.observed` and
 *    `include: ['schema_diff']` produces a `schema_diff` field in the
 *    parsed JSON output AND a `schema_diff.json` file on disk.
 *  - Malformed `target_schema` is silently dropped (no schema_diff field,
 *    no schema_diff.json file).
 *  - Absent `observed` is silently dropped.
 *  - The default include set behavior (no schema_diff request) is
 *    unaffected — preserves backward compatibility.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerOcEvidenceBundleTool } from '../../src/tools/oc-evidence-bundle';
import type {
  MCPToolDefinition,
  MCPResult,
  ToolHandler,
} from '../../src/types/mcp';

interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
}

class MockServer {
  public tools = new Map<string, RegisteredTool>();
  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { name, handler, definition });
  }
}

function parseResult(result: MCPResult): Record<string, unknown> {
  const text = result.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

function setup(): ToolHandler {
  const server = new MockServer();
  registerOcEvidenceBundleTool(
    server as unknown as Parameters<typeof registerOcEvidenceBundleTool>[0],
  );
  const reg = server.tools.get('oc_evidence_bundle');
  expect(reg).toBeDefined();
  return reg!.handler;
}

const schema = {
  version: 1,
  fields: [
    { name: 'title', type: 'string' },
    { name: 'statusCode', type: 'number' },
  ],
};

describe('oc_evidence_bundle — target_schema diff wiring', () => {
  test('produces schema_diff in the JSON response and writes schema_diff.json', async () => {
    const handler = setup();
    const result = await handler('sess', {
      include: ['schema_diff'],
      target_schema: schema,
      evidence: {
        snapshot: { observed: { title: 'Example', statusCode: 200 } },
      },
    });

    const out = parseResult(result);
    expect(out.parts).toEqual(expect.arrayContaining(['schema_diff.json']));
    expect(out.schema_diff).toBeDefined();
    const diff = out.schema_diff as Record<string, unknown>;
    expect(diff.matched).toEqual(['title', 'statusCode']);
    expect(diff.coverage).toBe(1);

    // schema_diff.json exists on disk and matches the response.
    const bundlePath = out.path as string;
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(bundlePath, 'schema_diff.json'), 'utf8'),
    );
    expect(onDisk.target_schema_version).toBe(1);
    expect(onDisk.diff).toEqual(diff);
  });

  test('malformed target_schema is silently dropped — no schema_diff in output', async () => {
    const handler = setup();
    const result = await handler('sess', {
      include: ['schema_diff'],
      target_schema: { version: 'not-a-number', fields: [] },
      evidence: { snapshot: { observed: { title: 'x' } } },
    });

    const out = parseResult(result);
    expect(out.parts).not.toEqual(expect.arrayContaining(['schema_diff.json']));
    expect(out.schema_diff).toBeUndefined();
  });

  test('target_schema with an unknown field type is silently dropped', async () => {
    const handler = setup();
    const result = await handler('sess', {
      include: ['schema_diff'],
      target_schema: { version: 1, fields: [{ name: 'publishedAt', type: 'date' }] },
      evidence: { snapshot: { observed: { publishedAt: '2026-05-27' } } },
    });

    const out = parseResult(result);
    expect(out.parts).not.toEqual(expect.arrayContaining(['schema_diff.json']));
    expect(out.schema_diff).toBeUndefined();
  });

  test('absent observed yields no schema_diff even when target_schema is valid', async () => {
    const handler = setup();
    const result = await handler('sess', {
      include: ['schema_diff'],
      target_schema: schema,
      evidence: { snapshot: {} },
    });

    const out = parseResult(result);
    expect(out.parts).not.toEqual(expect.arrayContaining(['schema_diff.json']));
    expect(out.schema_diff).toBeUndefined();
  });

  test('default behavior (no schema_diff request) is unchanged — no new fields', async () => {
    const handler = setup();
    const result = await handler('sess', {
      evidence: {
        snapshot: { dom: '<html></html>' },
      },
    });

    const out = parseResult(result);
    expect(out.parts).toEqual(['dom.json']);
    expect(out.schema_diff).toBeUndefined();
  });

  test('schema_diff coexists with other parts in the same bundle', async () => {
    const handler = setup();
    const result = await handler('sess', {
      include: ['dom', 'schema_diff'],
      target_schema: schema,
      evidence: {
        snapshot: {
          dom: '<html></html>',
          observed: { title: 't', statusCode: 200 },
        },
      },
    });

    const out = parseResult(result);
    expect(out.parts).toEqual(['dom.json', 'schema_diff.json']);
    expect(out.schema_diff).toBeDefined();
  });
});
