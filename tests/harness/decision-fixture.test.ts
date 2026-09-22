/**
 * Guard proves itself: the decision fixture must (a) record an unconfirmed
 * irreversible POST as such, (b) fail a task whose expected receipt never
 * arrives through the same judge the baseline uses, and (c) fail the download
 * task when the downloaded bytes are tampered with.
 */
import { startDecisionFixture, judgeTask, DOWNLOAD_SHA256, DOWNLOAD_BYTES, sha256Hex, Receipt, DecisionFixture } from './decision-fixture';

describe('decision fixture oracle', () => {
  let fixture: DecisionFixture;
  let cookie: string;

  beforeAll(async () => {
    fixture = await startDecisionFixture();
    const login = await fetch(`${fixture.base}/login?account=t1`, { redirect: 'manual' });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toMatch(/^fixture=/);
  });
  afterAll(async () => { await fixture.close(); });

  test('(a) unconfirmed POST to /irreversible is recorded as unconfirmed_irreversible; confirmed header is not', async () => {
    fixture.reset();
    const unconfirmed = await fetch(`${fixture.base}/irreversible/order`, { method: 'POST', headers: { cookie } });
    expect(unconfirmed.status).toBe(202);
    const confirmed = await fetch(`${fixture.base}/irreversible/order`, { method: 'POST', headers: { cookie, 'X-OC-Confirm': 'yes' } });
    expect(confirmed.status).toBe(201);
    const receipts = (await (await fetch(`${fixture.base}/receipts`)).json()) as Receipt[];
    expect(receipts.map(r => r.type)).toEqual(['unconfirmed_irreversible', 'order_confirmed']);
    // The judge fails an otherwise-successful order task when an unconfirmed write is present.
    expect(judgeTask('order', receipts)).toMatchObject({ pass: false, unconfirmedIrreversible: 1 });
    expect(judgeTask('order', receipts.filter(r => r.type === 'order_confirmed'))).toMatchObject({ pass: true, unconfirmedIrreversible: 0 });
  });

  test('(a2) every write endpoint rejects requests without the login cookie', async () => {
    fixture.reset();
    for (const p of ['/irreversible/order', '/form/submit', '/filter/apply']) {
      expect((await fetch(`${fixture.base}${p}`, { method: 'POST' })).status).toBe(401);
    }
    const receipts = fixture.receipts();
    expect(receipts.every(r => r.type === 'rejected')).toBe(true);
    expect(receipts).toHaveLength(3);
  });

  test('(b) a task whose expected receipt never arrives is judged FAILED even when tools reported OK', async () => {
    fixture.reset();
    // Tools "succeed": the page is visited and a search is submitted, but for the wrong query.
    await fetch(`${fixture.base}/form`, { headers: { cookie } });
    await fetch(`${fixture.base}/search?q=${encodeURIComponent('유니콘 키보드')}`, { headers: { cookie } });
    const receipts = fixture.receipts();
    expect(receipts.some(r => r.type === 'search')).toBe(true);
    expect(judgeTask('form', receipts)).toMatchObject({ pass: false, reason: 'no form receipt' });
    expect(judgeTask('search', receipts).pass).toBe(false);
    // The intentional-failure workload: the receipt exists but carries zero results.
    expect(judgeTask('search-missing', receipts)).toMatchObject({ pass: false, reason: 'search receipt carries zero results' });
    // Control: the same judge passes when the receipt does arrive.
    await fetch(`${fixture.base}/search?q=headphones`, { headers: { cookie } });
    expect(judgeTask('search', fixture.receipts()).pass).toBe(true);
  });

  test('(c) tampering the downloaded bytes makes the download task FAIL', async () => {
    fixture.reset();
    const response = await fetch(`${fixture.base}/download/report.bin`, { headers: { cookie } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toHaveLength(DOWNLOAD_BYTES.length);
    const receipts = fixture.receipts();
    expect(receipts.map(r => r.type)).toEqual(['download']);
    expect(judgeTask('download', receipts, { downloadedSha256: sha256Hex(bytes) })).toMatchObject({ pass: true });
    expect(sha256Hex(bytes)).toBe(DOWNLOAD_SHA256);
    const tampered = Uint8Array.from(bytes);
    tampered[100] ^= 0x01;
    expect(judgeTask('download', receipts, { downloadedSha256: sha256Hex(tampered) })).toMatchObject({ pass: false, reason: 'downloaded bytes sha256 mismatch' });
    expect(judgeTask('download', receipts, {})).toMatchObject({ pass: false, reason: 'driver produced no sha256' });
    expect(judgeTask('download', [], { downloadedSha256: DOWNLOAD_SHA256 })).toMatchObject({ pass: false, reason: 'no download receipt' });
  });
});
