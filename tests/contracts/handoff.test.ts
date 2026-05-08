import {
  HANDOFF_TOKEN_HEX_LENGTH,
  HandoffManager,
  bannerTagName,
  buildBannerScript,
  generateHandoffToken,
  verifyHandoffToken,
} from '../../src/contracts/handoff';

describe('handoff token — generation + timing-safe verify', () => {
  test('generated token is 64-char lowercase hex (32 bytes)', () => {
    const t = generateHandoffToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(t.length).toBe(HANDOFF_TOKEN_HEX_LENGTH);
  });

  test('successive calls produce different tokens', () => {
    const a = generateHandoffToken();
    const b = generateHandoffToken();
    expect(a).not.toBe(b);
  });

  test('verifyHandoffToken accepts an exact match', () => {
    const t = generateHandoffToken();
    expect(verifyHandoffToken(t, t)).toBe(true);
  });

  test('verifyHandoffToken rejects different tokens of correct length', () => {
    expect(verifyHandoffToken('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  test('verifyHandoffToken rejects malformed input without throwing', () => {
    expect(verifyHandoffToken('', '')).toBe(false);
    expect(verifyHandoffToken('not hex', 'a'.repeat(64))).toBe(false);
    expect(verifyHandoffToken('abc', 'a'.repeat(64))).toBe(false);
    expect(verifyHandoffToken('a'.repeat(64), 'XYZ' + 'a'.repeat(61))).toBe(false);
    // Wrong types
    expect(verifyHandoffToken(undefined as unknown as string, 'a'.repeat(64))).toBe(false);
    expect(verifyHandoffToken('a'.repeat(64), null as unknown as string)).toBe(false);
  });
});

describe('handoff banner', () => {
  test('bannerTagName uses operator-supplied suffix when provided', () => {
    expect(bannerTagName('cafef00d')).toBe('oc-handoff-cafef00d');
  });

  test('bannerTagName generates random hex suffix when not supplied', () => {
    const tag = bannerTagName();
    expect(tag).toMatch(/^oc-handoff-[0-9a-f]{8}$/);
  });

  test('bannerTagName rejects non-hex suffix', () => {
    expect(() => bannerTagName('not_hex')).toThrow();
  });

  test('buildBannerScript embeds txn / token / port / summary as JSON literals', () => {
    const src = buildBannerScript({
      txnId: 'txn-001',
      token: 'a'.repeat(64),
      port: 9201,
      summary: 'Manual pause',
      reason: 'manual_pause',
      tagSuffix: 'deadbeef',
    });
    expect(src).toContain('"txn-001"');
    expect(src).toContain('"' + 'a'.repeat(64) + '"');
    expect(src).toContain('9201');
    expect(src).toContain('"Manual pause"');
    expect(src).toContain('oc-handoff-deadbeef');
    // Closed shadow root for CSP isolation
    expect(src).toContain('attachShadow({ mode: "closed" })');
  });

  test('buildBannerScript escapes hostile summary text (no XSS path)', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const src = buildBannerScript({
      txnId: 't',
      token: 'a'.repeat(64),
      port: 1,
      summary: evil,
      reason: 'manual_pause',
    });
    // The summary lives inside a JSON-string literal (so the `<` becomes
    // < if needed) and is set via .textContent at runtime, never
    // .innerHTML — no parsable HTML can land in the DOM.
    expect(src).not.toContain('alert(1)</script>');
    expect(src).toContain('h.textContent = SUMMARY');
  });

  test('buildBannerScript is idempotent against re-injection', () => {
    const src = buildBannerScript({
      txnId: 't',
      token: 'a'.repeat(64),
      port: 1,
      summary: 's',
      reason: 'manual_pause',
      tagSuffix: 'aaaaaaaa',
    });
    // The "if customElements already has it, return" guard prevents
    // double-registration on every navigation.
    expect(src).toContain('window.customElements.get(TAG)');
  });

  test('buildBannerScript falls back to "unknown" reason class for invalid kinds', () => {
    const src = buildBannerScript({
      txnId: 't',
      token: 'a'.repeat(64),
      port: 1,
      summary: 's',
      // @ts-expect-error — feeding a deliberately-invalid reason value
      reason: 'made-up',
      tagSuffix: 'aaaaaaaa',
    });
    expect(src).toContain('"unknown"');
  });
});

describe('HandoffManager — basic lifecycle', () => {
  let now = 0;
  const make = () =>
    new HandoffManager({
      timeoutMs: 1000,
      maxPerTxn: 3,
      now: () => now,
    });

  test('create() returns pending record with fresh token + expires_at', () => {
    now = 1000;
    const mgr = make();
    const r = mgr.create({ txn_id: 't1', reason: 'manual_pause', summary: 's' });
    expect(r.status).toBe('pending');
    expect(r.attempt).toBe(1);
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.expires_at).toBe(2000);
  });

  test('create() rotates the token on subsequent attempts', () => {
    now = 100;
    const mgr = make();
    const a = mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    const b = mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    expect(b.attempt).toBe(2);
    expect(b.token).not.toBe(a.token);
  });

  test('create() throws when per-txn cap is exhausted', () => {
    now = 0;
    const mgr = make();
    mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    expect(() => mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' })).toThrow(/cap exhausted/);
  });

  test('get() flips pending → expired when wall time passes', () => {
    now = 1000;
    const mgr = make();
    mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    now = 2500; // > expires_at (2000)
    expect(mgr.get('t')?.status).toBe('expired');
  });
});

describe('HandoffManager — resume', () => {
  let now = 0;
  const make = () =>
    new HandoffManager({ timeoutMs: 1000, maxPerTxn: 3, now: () => now });

  test('valid token + pending status → resumed', () => {
    now = 100;
    const mgr = make();
    const rec = mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    const r = mgr.resume('t', rec.token);
    expect(r.ok).toBe(true);
    expect(r.record?.status).toBe('resumed');
    expect(r.record?.resumed_at).toBe(100);
  });

  test('wrong token → wrong_token, status unchanged', () => {
    const mgr = make();
    mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    const r = mgr.resume('t', 'a'.repeat(64));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_token');
    expect(mgr.get('t')?.status).toBe('pending');
  });

  test('unknown txn → unknown_txn', () => {
    const mgr = make();
    expect(mgr.resume('nope', 'a'.repeat(64)).reason).toBe('unknown_txn');
  });

  test('past-expiry → expired (and stays expired on retry)', () => {
    now = 0;
    const mgr = make();
    const rec = mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    now = 5000;
    const r = mgr.resume('t', rec.token);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('expired');
    // Retry — still expired (status already moved to 'expired' on first
    // call, but the response remains stable across retries).
    expect(mgr.resume('t', rec.token).reason).toBe('expired');
  });

  test('single-use: a second call with the same token returns wrong_status', () => {
    const mgr = make();
    const rec = mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    expect(mgr.resume('t', rec.token).ok).toBe(true);
    const second = mgr.resume('t', rec.token);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('wrong_status');
  });

  test('rotated token invalidates the previous one', () => {
    const mgr = make();
    const a = mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    const b = mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    // The old token no longer matches the active record's token.
    expect(mgr.resume('t', a.token).reason).toBe('wrong_token');
    expect(mgr.resume('t', b.token).ok).toBe(true);
  });
});

describe('HandoffManager — abort + sweep + list', () => {
  let now = 0;
  const make = () =>
    new HandoffManager({ timeoutMs: 1000, maxPerTxn: 3, now: () => now });

  test('abort() flips pending → aborted', () => {
    now = 0;
    const mgr = make();
    mgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    expect(mgr.abort('t')?.status).toBe('aborted');
  });

  test('list() shows every active record', () => {
    const mgr = make();
    mgr.create({ txn_id: 'a', reason: 'unknown', summary: 's' });
    mgr.create({ txn_id: 'b', reason: 'unknown', summary: 's' });
    expect(mgr.list().map((r) => r.txn_id).sort()).toEqual(['a', 'b']);
  });

  test('sweep() purges terminal records older than 24h, leaves recent ones', () => {
    now = 0;
    const mgr = make();
    mgr.create({ txn_id: 'old', reason: 'unknown', summary: 's' });
    now = 100;
    mgr.abort('old'); // expires_at was 1000; now=100 — still within retention
    now = 100 + 24 * 60 * 60 * 1000 + 5000; // > 24h after expires_at
    expect(mgr.sweep()).toBe(1);
    expect(mgr.list()).toEqual([]);
  });

  test('sweep() retention is anchored on termination time, not configured TTL', () => {
    // Configure a long handoff TTL (e.g. 8 hours) and abort the handoff
    // very quickly. 24h after termination, the record should be purged
    // even though `expires_at` is far in the future. Without anchoring
    // GC on `terminated_at`, the record would linger for `TTL - elapsed`
    // extra time beyond the documented 24h window.
    now = 0;
    const longTtlMgr = new HandoffManager({
      timeoutMs: 8 * 60 * 60 * 1000, // 8 hours
      maxPerTxn: 3,
      now: () => now,
    });
    longTtlMgr.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    now = 1000;
    longTtlMgr.abort('t');
    // 24h + 1s after the abort, well before the original expires_at
    // (which is 8h after creation).
    now = 1000 + 24 * 60 * 60 * 1000 + 1000;
    expect(longTtlMgr.sweep()).toBe(1);
    expect(longTtlMgr.list()).toEqual([]);
  });
});
