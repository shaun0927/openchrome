import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseTransactionUri,
  readEvidenceBundle,
  readTransactionResource,
  writeEvidenceBundle,
  type BundleManifest,
} from '../../src/contracts/evidence';
import type { TransactionRecord } from '../../src/contracts/runtime';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-evi-'));
}

function record(over: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    txn_id: 'txn-001',
    contract_id: 'amazon.checkout',
    verdict: 'postcondition_violation',
    started_at: 1000,
    ended_at: 2000,
    wall_ms: 1000,
    retries: 0,
    ...over,
  };
}

describe('writeEvidenceBundle — happy path', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('writes bundle.json + every referenced file', async () => {
    const result = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_screenshot: Buffer.from('PNG_BYTES_OK'),
        fail_dom: { tag: 'body', children: [{ tag: 'h1', text: 'Order Failed' }] },
        trace_slice: [
          { ts: 1500, seq: 1, kind: 'Network.responseReceived', body: { status: 500 } },
        ],
        suggested_next_steps: [{ id: 's1', title: 'Retry', body: 'try again' }],
      },
      { rootDir: root },
    );
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    const m = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')) as BundleManifest;
    expect(m.schema_version).toBe(1);
    expect(m.verdict).toBe('postcondition_violation');
    expect(m.files.fail_screenshot).toBe('fail_screenshot.png');
    expect(m.files.fail_dom).toBe('fail_dom.json');
    expect(m.files.trace_slice).toBe('trace_slice.jsonl');
    // Every referenced file exists
    expect(fs.existsSync(path.join(result.bundleDir, m.files.fail_screenshot!))).toBe(true);
    expect(fs.existsSync(path.join(result.bundleDir, m.files.fail_dom!))).toBe(true);
    expect(fs.existsSync(path.join(result.bundleDir, m.files.trace_slice!))).toBe(true);
  });

  test('omitted inputs do not appear in files map', async () => {
    const r = await writeEvidenceBundle({ transaction: record() }, { rootDir: root });
    const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as BundleManifest;
    expect(m.files).toEqual({});
  });

  test('byte_size is positive and sane', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_dom: { large: 'x'.repeat(5000) },
      },
      { rootDir: root },
    );
    expect(r.byteSize).toBeGreaterThan(1000);
  });
});

describe('writeEvidenceBundle — atomic write', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('manifest exists ⇒ all referenced files exist (post-condition invariant)', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_screenshot: Buffer.from('PNG'),
        fail_dom: { ok: true },
        trace_slice: [{ ts: 1, seq: 1, kind: 'k', body: {} }],
      },
      { rootDir: root },
    );
    const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as BundleManifest;
    for (const rel of Object.values(m.files)) {
      if (typeof rel === 'string') {
        expect(fs.existsSync(path.join(r.bundleDir, rel))).toBe(true);
      }
    }
  });

  test('readEvidenceBundle returns null when manifest is missing', () => {
    expect(readEvidenceBundle('does-not-exist', { rootDir: root })).toBeNull();
  });

  test('readEvidenceBundle returns null when a referenced file is gone (atomic guard)', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_screenshot: Buffer.from('PNG'),
      },
      { rootDir: root },
    );
    // Simulate a partial-state bundle: delete the screenshot but keep manifest
    fs.unlinkSync(path.join(r.bundleDir, 'fail_screenshot.png'));
    const m = readEvidenceBundle(record().txn_id, { rootDir: root });
    expect(m).toBeNull();
  });

  test('readEvidenceBundle returns null for malformed manifest shapes (not a crash)', () => {
    const txn = record({ txn_id: 'malformed' });
    const bundleDir = path.join(root, txn.txn_id);
    fs.mkdirSync(bundleDir, { recursive: true });
    // manifest is a top-level array — `Object.values(arr)` would
    // succeed, but the original `Object.values(manifest.files)`
    // assumed the document shape was the contract.
    fs.writeFileSync(path.join(bundleDir, 'bundle.json'), JSON.stringify(['oops']));
    expect(readEvidenceBundle(txn.txn_id, { rootDir: root })).toBeNull();
    // manifest is a JSON null
    fs.writeFileSync(path.join(bundleDir, 'bundle.json'), 'null');
    expect(readEvidenceBundle(txn.txn_id, { rootDir: root })).toBeNull();
    // manifest.files is null
    fs.writeFileSync(
      path.join(bundleDir, 'bundle.json'),
      JSON.stringify({ schema_version: 1, txn_id: 'malformed', files: null }),
    );
    expect(readEvidenceBundle(txn.txn_id, { rootDir: root })).toBeNull();
    // manifest.files is an array (Object.values would silently work
    // but the values would be primitives, not file paths)
    fs.writeFileSync(
      path.join(bundleDir, 'bundle.json'),
      JSON.stringify({ schema_version: 1, txn_id: 'malformed', files: [] }),
    );
    expect(readEvidenceBundle(txn.txn_id, { rootDir: root })).toBeNull();
  });

  test('crash-safety: temp manifest does not survive when manifest missing', async () => {
    // The temp file should not exist after a successful rename; if a
    // crash happens DURING write, .bundle.json.tmp may exist while
    // bundle.json does not. Our reader correctly returns null in that case.
    const txn = record({ txn_id: 'txn-crash' });
    const bundleDir = path.join(root, txn.txn_id);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, '.bundle.json.tmp'), '{ "partial": true }');
    fs.writeFileSync(path.join(bundleDir, 'fail_dom.json'), '{}');
    expect(readEvidenceBundle(txn.txn_id, { rootDir: root })).toBeNull();
  });
});

describe('writeEvidenceBundle — redaction', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('credentials in DOM snapshots are scrubbed before write', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_dom: {
          formFields: [{ name: 'password', value: 'hunter2' }],
          requestUrl: 'https://x/?password=topsecret',
        },
      },
      { rootDir: root },
    );
    const dom = fs.readFileSync(path.join(r.bundleDir, 'fail_dom.json'), 'utf8');
    expect(dom).not.toContain('hunter2');
    expect(dom).not.toContain('topsecret');
  });

  test('credentials in transaction record are scrubbed in manifest', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: {
          ...record(),
          // Stash a credential-bearing field; the manifest must scrub
          // it the same way DOM/trace payloads are scrubbed at write
          // boundary.
          last_url: 'https://x/?password=topsecret&api_key=AKIAEXAMPLE',
        } as TransactionRecord & { last_url: string },
      },
      { rootDir: root },
    );
    const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as BundleManifest;
    const dump = JSON.stringify(m);
    expect(dump).not.toContain('topsecret');
    expect(dump).not.toContain('AKIAEXAMPLE');
  });

  test('Authorization headers in trace slice are scrubbed', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        trace_slice: [
          {
            ts: 1,
            seq: 1,
            kind: 'Network.requestWillBeSent',
            body: { request: { headers: { Authorization: 'Bearer abc.def.ghi' } } },
          },
        ],
      },
      { rootDir: root },
    );
    const trace = fs.readFileSync(path.join(r.bundleDir, 'trace_slice.jsonl'), 'utf8');
    expect(trace).not.toContain('Bearer abc.def.ghi');
    expect(trace).toContain('[REDACTED]');
  });
});

describe('writeEvidenceBundle — truncation', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('truncated DOM honors the cap even when JSON re-escaping inflates the preview', async () => {
    // Payload built mostly of `"` and `\` — every preview byte doubles
    // when JSON.stringify wraps it into the manifest's `preview` field.
    // A naive `previewBudget = cap - wrapperOverhead` would overshoot;
    // the binary-searched preview keeps the rendered file ≤ cap.
    const heavy = '"\\'.repeat(50_000); // 100 KB of escape-prone chars
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_dom: { huge: heavy },
      },
      { rootDir: root, maxBytes: 5 * 1024 * 1024 },
    );
    const onDisk = fs.statSync(path.join(r.bundleDir, 'fail_dom.json')).size;
    // Per-DOM cap is min(DOM_TRUNCATE_BYTES=500K, maxBytes - byteSize).
    // Whichever wins, the rendered file must not exceed that cap.
    expect(onDisk).toBeLessThanOrEqual(500 * 1024);
  });

  test('oversize fail_dom is truncated and flagged', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_dom: { huge: 'x'.repeat(2 * 1024 * 1024) }, // 2 MB > 500 KB cap
      },
      { rootDir: root },
    );
    const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as BundleManifest;
    expect(m.truncated?.fail_dom).toBe(true);
    const domStr = fs.readFileSync(path.join(r.bundleDir, 'fail_dom.json'), 'utf8');
    expect(domStr).toContain('"_truncated":true');
  });

  test('manifest under tight maxBytes drops suggested_next_steps and flags truncated.manifest', async () => {
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        // Build a chunky next-steps array that, together with the
        // transaction record, pushes the manifest past the cap.
        suggested_next_steps: Array.from({ length: 50 }, (_, i) => ({
          id: `s${i}`,
          title: 'long step title repeated to use bytes ' + 'x'.repeat(200),
          body: 'detailed body for the step ' + 'y'.repeat(400),
        })),
      },
      { rootDir: root, maxBytes: 4 * 1024 },
    );
    const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as BundleManifest;
    expect(m.truncated?.manifest).toBe(true);
    expect(m.suggested_next_steps).toBeUndefined();
  });

  test('large transaction payload is compacted so manifest honors maxBytes', async () => {
    const hugePayload = 'x'.repeat(128 * 1024);
    const r = await writeEvidenceBundle(
      {
        transaction: {
          ...record(),
          post_evidence: {
            assertion_kind: 'dom_text',
            passed: false,
            details: { haystack: hugePayload },
          },
          skill_result: { transcript: hugePayload },
        } as TransactionRecord & { skill_result: { transcript: string } },
        suggested_next_steps: [
          { id: 's1', title: 'inspect', body: 'large suggestion ' + hugePayload },
        ],
      },
      { rootDir: root, maxBytes: 4 * 1024 },
    );
    const manifestSize = fs.statSync(r.manifestPath).size;
    const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as BundleManifest;
    expect(manifestSize).toBeLessThanOrEqual(4 * 1024);
    expect(r.byteSize).toBeLessThanOrEqual(4 * 1024);
    expect(m.byte_size).toBe(r.byteSize);
    expect(m.truncated?.manifest).toBe(true);
    expect(m.suggested_next_steps).toBeUndefined();
    expect(m.transaction.txn_id).toBe('txn-001');
    expect((m.transaction as TransactionRecord & { skill_result?: unknown }).skill_result).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain(hugePayload.slice(0, 100));
  });

  test('a single screenshot larger than maxBytes is dropped, not silently kept', async () => {
    const big = Buffer.alloc(200 * 1024); // 200 KB
    const r = await writeEvidenceBundle(
      {
        transaction: record(),
        fail_screenshot: big,
      },
      { rootDir: root, maxBytes: 50 * 1024 }, // 50 KB cap
    );
    const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as BundleManifest;
    expect(m.truncated?.fail_screenshot).toBe(true);
    expect(m.files.fail_screenshot).toBeUndefined();
    expect(fs.existsSync(path.join(r.bundleDir, 'fail_screenshot.png'))).toBe(false);
    expect(r.byteSize).toBeLessThan(50 * 1024 + 4 * 1024); // manifest only, not 200KB
  });
});

describe('readEvidenceBundle — round trip', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('round-trips manifest fields', async () => {
    const txn = record({ txn_id: 'rt-001', verdict: 'success' });
    await writeEvidenceBundle({ transaction: txn }, { rootDir: root });
    const m = readEvidenceBundle('rt-001', { rootDir: root });
    expect(m?.txn_id).toBe('rt-001');
    expect(m?.verdict).toBe('success');
    expect(m?.contract_id).toBe(txn.contract_id);
  });
});

describe('parseTransactionUri', () => {
  test('parses bare txn_id', () => {
    expect(parseTransactionUri('openchrome://transaction/abc')).toBe('abc');
  });

  test('returns null for non-transaction URI', () => {
    expect(parseTransactionUri('openchrome://trace/x/meta')).toBeNull();
    expect(parseTransactionUri('http://example.com/x')).toBeNull();
  });

  test('returns null for nested paths (v1 has no sub-paths)', () => {
    expect(parseTransactionUri('openchrome://transaction/abc/meta')).toBeNull();
  });

  test('decodes URI-encoded ids', () => {
    expect(parseTransactionUri('openchrome://transaction/foo%20bar')).toBe('foo bar');
  });

  test('rejects percent-encoded path traversal', () => {
    // The literal-`/` guard runs before decode, so the encoded forms
    // sneak past unless we re-validate after decodeURIComponent.
    expect(parseTransactionUri('openchrome://transaction/%2e%2e%2fother')).toBeNull();
    expect(parseTransactionUri('openchrome://transaction/%2E%2E')).toBeNull();
    expect(parseTransactionUri('openchrome://transaction/%2e')).toBeNull();
    expect(parseTransactionUri('openchrome://transaction/foo%2fbar')).toBeNull();
    expect(parseTransactionUri('openchrome://transaction/foo%5Cbar')).toBeNull();
  });

  test('rejects malformed percent-encoding instead of throwing', () => {
    expect(parseTransactionUri('openchrome://transaction/%E0%A4%A')).toBeNull();
  });
});

describe('readTransactionResource', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns the manifest JSON for an existing bundle', async () => {
    const txn = record({ txn_id: 'rsrc-1' });
    await writeEvidenceBundle({ transaction: txn }, { rootDir: root });
    const r = await readTransactionResource('openchrome://transaction/rsrc-1', { rootDir: root });
    expect(r?.mimeType).toBe('application/json');
    const parsed = JSON.parse(r!.text) as BundleManifest;
    expect(parsed.txn_id).toBe('rsrc-1');
  });

  test('returns null for unknown bundle', async () => {
    expect(
      await readTransactionResource('openchrome://transaction/missing', { rootDir: root }),
    ).toBeNull();
  });

  test('returns null for non-transaction URI', async () => {
    expect(await readTransactionResource('openchrome://other')).toBeNull();
  });

  test('returns discovery help for bare prefix URI (matches resources/list entry)', async () => {
    const r = await readTransactionResource('openchrome://transaction/');
    expect(r?.mimeType).toBe('application/json');
    const payload = JSON.parse(r!.text);
    expect(payload.uri).toBe('openchrome://transaction/');
    expect(payload.hint).toMatch(/Per-transaction evidence bundles/);
  });
});
