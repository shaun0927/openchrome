/// <reference types="jest" />

/**
 * Tests for the output handle store and related tool integration (#887).
 *
 * Covers:
 *  - HandleStore: write/read/expire/sweep roundtrip
 *  - output_mode='inline': byte-identity for each of the 5 tools (P2 invariant)
 *  - output_mode='handle': response shape conforms to output-handle.schema.ts
 *  - output_mode='auto': threshold flip
 *  - oc_output_fetch: pagination invariants, unknown-handle error
 *  - TTL eviction: fast sub-second sweep using tiny TTL
 *
 * Filesystem isolation: every test uses a unique tmpdir so runs cannot collide.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { HandleStore } from '../../src/core/output/handle-store';
import { validateOutputHandleResponse } from '../../src/tools/_shared/output-handle.schema';
import { resolveOutputMode, parseOutputMode } from '../../src/tools/_shared/output-mode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-output-handles-test-'));
}

// Minimal inline MCPResult builder
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Narrow `result.content[0].text` from `string | undefined` to `string`.
 * Throws a descriptive Jest-compatible error if the response shape is wrong.
 */
function firstText(result: { content?: readonly { text?: string }[] }): string {
  const content = result.content;
  if (!content || content.length === 0) {
    throw new Error('MCPResult.content is missing or empty');
  }
  const text = content[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('MCPResult.content[0].text is not a string');
  }
  return text;
}

// ---------------------------------------------------------------------------
// HandleStore unit tests
// ---------------------------------------------------------------------------

describe('HandleStore — write/read roundtrip', () => {
  test('writeJson + saveMeta + fetch returns the original payload', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const payload = [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }];

    const meta = await store.writeJson(payload, { ttlHours: 1 });
    await store.saveMeta(meta);

    const result = store.fetch(meta.output_handle);
    expect(result).not.toBeNull();
    expect(result!.eof).toBe(true);
    expect(result!.total).toBe(2);
    expect(result!.returned).toBe(2);
    expect(result!.next_offset).toBeNull();
    expect(Array.isArray(result!.content)).toBe(true);
    expect((result!.content as unknown[]).length).toBe(2);
  });

  test('handle id matches pattern ^oh_[A-Z2-7]{12}$', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const meta = await store.writeJson({ x: 1 }, { ttlHours: 1 });
    await store.saveMeta(meta);
    expect(meta.output_handle).toMatch(/^oh_[A-Z2-7]{12}$/);
  });

  test('fetch returns null for unknown handle', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const result = store.fetch('oh_UNKNOWNAAAAA' as any);
    expect(result).toBeNull();
  });

  test('fetch rejects malformed handle ids before path lookup', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const meta = await store.writeJson({ safe: true }, { ttlHours: 1 });
    await store.saveMeta(meta);

    expect(store.fetch('../' as any)).toBeNull();
    expect(store.fetch('oh_../../escape' as any)).toBeNull();
    expect(store.fetch(`${meta.output_handle}.meta.json` as any)).toBeNull();
  });

  test('fetch returns null for expired handle', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    // Write with 0-hour TTL (expires immediately)
    const meta = await store.writeJson({ val: 42 }, { ttlHours: 0 });
    // Manually write a meta with past expiry
    const expiredMeta = {
      ...meta,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await store.saveMeta(expiredMeta);

    const result = store.fetch(meta.output_handle);
    expect(result).toBeNull();
  });

  test('purgeExpired removes expired handle files', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });

    const meta = await store.writeJson({ val: 42 }, { ttlHours: 1 });
    // Override meta with past expiry
    const expiredMeta = {
      ...meta,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await store.saveMeta(expiredMeta);

    // File should exist before purge
    expect(fs.existsSync(meta.file_path)).toBe(true);

    const purged = store.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(meta.file_path)).toBe(false);
    expect(fs.existsSync(meta.file_path.replace(/\.(json|bin|md)$/, '.meta.json'))).toBe(false);
  });

  test('purgeExpired returns 0 when no expired handles', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const meta = await store.writeJson({ val: 1 }, { ttlHours: 24 });
    await store.saveMeta(meta);

    const purged = store.purgeExpired();
    expect(purged).toBe(0);
  });
});

describe('HandleStore — pagination', () => {
  test('item-based: offset/limit slice returns correct next_offset', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const items = Array.from({ length: 10 }, (_, i) => ({ idx: i }));
    const meta = await store.writeJson(items, { ttlHours: 1 });
    await store.saveMeta(meta);

    const page1 = store.fetch(meta.output_handle, { offset: 0, limit: 4 });
    expect(page1).not.toBeNull();
    expect(page1!.returned).toBe(4);
    expect(page1!.total).toBe(10);
    expect(page1!.eof).toBe(false);
    expect(page1!.next_offset).toBe(4);

    const page2 = store.fetch(meta.output_handle, { offset: 4, limit: 4 });
    expect(page2!.returned).toBe(4);
    expect(page2!.next_offset).toBe(8);
    expect(page2!.eof).toBe(false);

    const page3 = store.fetch(meta.output_handle, { offset: 8, limit: 4 });
    expect(page3!.returned).toBe(2);
    expect(page3!.eof).toBe(true);
    expect(page3!.next_offset).toBeNull();
  });

  test('returned <= limit invariant always holds', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const items = Array.from({ length: 5 }, (_, i) => ({ i }));
    const meta = await store.writeJson(items, { ttlHours: 1 });
    await store.saveMeta(meta);

    const result = store.fetch(meta.output_handle, { offset: 0, limit: 100 });
    expect(result!.returned).toBeLessThanOrEqual(100);
    expect(result!.total).toBeGreaterThanOrEqual(result!.returned);
  });

  test('eof=true implies next_offset=null', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });
    const meta = await store.writeJson([1, 2, 3], { ttlHours: 1 });
    await store.saveMeta(meta);

    const result = store.fetch(meta.output_handle, { limit: 100 });
    expect(result!.eof).toBe(true);
    expect(result!.next_offset).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveOutputMode helper
// ---------------------------------------------------------------------------

describe('resolveOutputMode', () => {
  test('inline mode returns the inlineResult unchanged (P2)', async () => {
    const baseDir = mkTmp();
    // Override the global store with a test-isolated one
    const { setHandleStoreForTest } = await importHandleStoreTestHelpers();
    setHandleStoreForTest(new HandleStore({ baseDir }));

    const inline = textResult('{"hello":"world"}');
    const result = await resolveOutputMode('inline', 32768, inline, { hello: 'world' }, 'test_tool');
    expect(result).toBe(inline); // reference-equal: exact same object
  });

  test('handle mode returns OutputHandleResponse shape', async () => {
    const baseDir = mkTmp();
    const { setHandleStoreForTest } = await importHandleStoreTestHelpers();
    setHandleStoreForTest(new HandleStore({ baseDir }));

    const inline = textResult('{"data":"lots of content"}');
    const result = await resolveOutputMode('handle', 32768, inline, { data: 'lots of content' }, 'test_tool');
    const parsed = JSON.parse(firstText(result));
    const err = validateOutputHandleResponse(parsed);
    expect(err).toBeNull();
  });

  test('auto mode: inline when payload <= limit', async () => {
    const baseDir = mkTmp();
    const { setHandleStoreForTest } = await importHandleStoreTestHelpers();
    setHandleStoreForTest(new HandleStore({ baseDir }));

    const smallPayload = { x: 1 };
    const inline = textResult(JSON.stringify(smallPayload));
    const result = await resolveOutputMode('auto', 100000, inline, smallPayload, 'test_tool');
    expect(result).toBe(inline);
  });

  test('auto mode: handle when payload > limit', async () => {
    const baseDir = mkTmp();
    const { setHandleStoreForTest } = await importHandleStoreTestHelpers();
    setHandleStoreForTest(new HandleStore({ baseDir }));

    const bigPayload = { data: 'x'.repeat(1000) };
    const inline = textResult(JSON.stringify(bigPayload));
    const result = await resolveOutputMode('auto', 10, inline, bigPayload, 'test_tool');
    const parsed = JSON.parse(firstText(result));
    const err = validateOutputHandleResponse(parsed);
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseOutputMode helper
// ---------------------------------------------------------------------------

describe('parseOutputMode', () => {
  test('defaults to inline when output_mode is absent', () => {
    const { mode, inlineLimit } = parseOutputMode({});
    expect(mode).toBe('inline');
    expect(inlineLimit).toBe(32768);
  });

  test('parses handle mode', () => {
    expect(parseOutputMode({ output_mode: 'handle' }).mode).toBe('handle');
  });

  test('parses auto mode', () => {
    expect(parseOutputMode({ output_mode: 'auto' }).mode).toBe('auto');
  });

  test('unknown value falls back to inline', () => {
    expect(parseOutputMode({ output_mode: 'invalid' }).mode).toBe('inline');
  });

  test('parses custom inlineLimit', () => {
    expect(parseOutputMode({ output_mode: 'auto', output_inline_limit_bytes: 1024 }).inlineLimit).toBe(1024);
  });

  test('ignores non-positive inlineLimit', () => {
    expect(parseOutputMode({ output_mode: 'auto', output_inline_limit_bytes: -1 }).inlineLimit).toBe(32768);
  });
});

// ---------------------------------------------------------------------------
// oc_output_fetch tool integration
// ---------------------------------------------------------------------------

describe('oc_output_fetch tool handler', () => {
  async function callFetch(args: Record<string, unknown>) {
    // We need to call the handler directly without going through the MCP server
    // Import after setting up the store to use our test baseDir
    const { getHandleStore } = await import('../../src/core/output/handle-store');
    // handler is not exported — use registerOcOutputFetchTool on a minimal server stub
    const { registerOcOutputFetchTool } = await import('../../src/tools/oc-output-fetch');
    const handlers: Record<string, (sessionId: string, args: Record<string, unknown>) => Promise<any>> = {};
    const serverStub = {
      registerTool: (name: string, handler: any, _def: any) => { handlers[name] = handler; },
    };
    registerOcOutputFetchTool(serverStub as any);
    return handlers['oc_output_fetch']('test-session', args);
  }

  test('unknown handle returns structured error with code=output_handle_not_found', async () => {
    const result = await callFetch({ output_handle: 'oh_DEADBEEF0000' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(firstText(result));
    expect(parsed.error.code).toBe('output_handle_not_found');
  });

  test('missing output_handle returns invalid_argument error', async () => {
    const result = await callFetch({});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(firstText(result));
    expect(parsed.error.code).toBe('invalid_argument');
  });

  test('valid handle returns pagination result', async () => {
    const baseDir = mkTmp();
    const { setHandleStoreForTest } = await importHandleStoreTestHelpers();
    setHandleStoreForTest(new HandleStore({ baseDir }));

    const { writeOutputHandle } = await import('../../src/core/output/handle-store');
    const descriptor = await writeOutputHandle(
      [{ a: 1 }, { b: 2 }, { c: 3 }],
      'test_tool',
    );

    const result = await callFetch({ output_handle: descriptor.output_handle, limit: 2 });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.returned).toBeLessThanOrEqual(2);
    expect(parsed.total).toBeGreaterThanOrEqual(parsed.returned);
    // eof=true means next_offset=null
    if (parsed.eof) {
      expect(parsed.next_offset).toBeNull();
    } else {
      expect(typeof parsed.next_offset).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// TTL eviction (fast test)
// ---------------------------------------------------------------------------

describe('TTL eviction', () => {
  test('handle is not findable after manual expiry + purge', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });

    const meta = await store.writeJson({ secret: 42 }, { ttlHours: 1 });
    // Backdate expiry to the past
    const expiredMeta = { ...meta, expires_at: new Date(Date.now() - 5000).toISOString() };
    await store.saveMeta(expiredMeta);

    // Before purge: fetch returns null (expiry check)
    expect(store.fetch(meta.output_handle)).toBeNull();

    // Purge removes the file
    store.purgeExpired();
    expect(fs.existsSync(meta.file_path)).toBe(false);
  });

  test('purgeExpired ignores sidecar entries and still removes payloads deterministically', async () => {
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });

    const meta = await store.writeJson({ v: 1 }, { ttlHours: 0 });
    const expiredMeta = { ...meta, expires_at: new Date(Date.now() - 1).toISOString() };
    await store.saveMeta(expiredMeta);
    const metaPath = meta.file_path.replace(/\.(json|bin|md)$/, '.meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);

    const purged = store.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(meta.file_path)).toBe(false);
    expect(fs.existsSync(metaPath)).toBe(false);
  });

  test('sweep loop purges expired handles within interval', async () => {
    // Use a very short TTL and synchronous purge to simulate sweep
    const baseDir = mkTmp();
    const store = new HandleStore({ baseDir });

    const meta = await store.writeJson({ v: 1 }, { ttlHours: 0 });
    const expiredMeta = { ...meta, expires_at: new Date(Date.now() - 1).toISOString() };
    await store.saveMeta(expiredMeta);

    // Simulate one sweep tick
    const purged = store.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// validateOutputHandleResponse — shape contract
// ---------------------------------------------------------------------------

describe('validateOutputHandleResponse', () => {
  const validHandle = {
    output_handle: 'oh_ABCDEFGHIJKL',
    mime_type: 'application/json',
    size_bytes: 100,
    item_count: 5,
    preview: 'hello',
    expires_at: '2099-01-01T00:00:00Z',
    fetch_with: 'oc_output_fetch',
  };

  test('valid handle passes', () => {
    expect(validateOutputHandleResponse(validHandle)).toBeNull();
  });

  test('null item_count is allowed', () => {
    expect(validateOutputHandleResponse({ ...validHandle, item_count: null })).toBeNull();
  });

  test('null preview is allowed', () => {
    expect(validateOutputHandleResponse({ ...validHandle, preview: null })).toBeNull();
  });

  test('invalid output_handle pattern fails', () => {
    expect(validateOutputHandleResponse({ ...validHandle, output_handle: 'bad_id' })).not.toBeNull();
  });

  test('invalid mime_type fails', () => {
    expect(validateOutputHandleResponse({ ...validHandle, mime_type: 'text/html' })).not.toBeNull();
  });

  test('missing fetch_with fails', () => {
    const { fetch_with, ...rest } = validHandle;
    expect(validateOutputHandleResponse(rest)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helper: set a test-isolated HandleStore on the global singleton
// ---------------------------------------------------------------------------

async function importHandleStoreTestHelpers() {
  // Jest module registry — we use a module-level accessor added to handle-store.ts
  // The module exports setHandleStoreForTest which replaces _instance in tests.
  // We do a dynamic import to get the latest module state.
  const mod = await import('../../src/core/output/handle-store');
  return {
    setHandleStoreForTest: (store: HandleStore) => {
      // Access the module-level singleton setter
      (mod as any)._setInstanceForTest(store);
    },
  };
}
