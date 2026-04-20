import {
  REQUEST_ID_HEADER,
  REQUEST_ID_HEADER_LOWER,
  generateRequestId,
  normalizeRequestId,
  resolveRequestId,
} from '../../src/observability/request-id';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request-id', () => {
  test('header constants are canonical', () => {
    expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
    expect(REQUEST_ID_HEADER_LOWER).toBe('x-request-id');
  });

  test('generateRequestId produces UUID v7', () => {
    const id = generateRequestId();
    expect(id).toMatch(UUID_V7_RE);
  });

  test('generateRequestId is monotonic over time', () => {
    const a = generateRequestId();
    // Sleep a millisecond-worth of work to advance the timestamp.
    const start = Date.now();
    while (Date.now() === start) { /* spin briefly */ }
    const b = generateRequestId();
    expect(a < b).toBe(true);
  });

  test('normalizeRequestId accepts well-formed values', () => {
    expect(normalizeRequestId('abc-123_4:5.6')).toBe('abc-123_4:5.6');
    expect(normalizeRequestId('  trimmed-me  ')).toBe('trimmed-me');
  });

  test('normalizeRequestId rejects bad values', () => {
    expect(normalizeRequestId('')).toBeNull();
    expect(normalizeRequestId('   ')).toBeNull();
    expect(normalizeRequestId(undefined)).toBeNull();
    expect(normalizeRequestId(123 as unknown)).toBeNull();
    expect(normalizeRequestId('contains space')).toBeNull();
    expect(normalizeRequestId('illegal/char')).toBeNull();
    expect(normalizeRequestId('x'.repeat(200))).toBeNull();
  });

  test('resolveRequestId echoes a valid header, else mints UUID v7', () => {
    expect(resolveRequestId('my-trace-42')).toBe('my-trace-42');
    const minted = resolveRequestId(undefined);
    expect(minted).toMatch(UUID_V7_RE);
    const minted2 = resolveRequestId('has spaces not allowed');
    expect(minted2).toMatch(UUID_V7_RE);
  });
});
