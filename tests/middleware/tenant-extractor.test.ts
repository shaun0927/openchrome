import {
  assertValidTenantId,
  extractTenantId,
  MAX_TENANT_ID_LENGTH,
  TENANT_HEADER,
  TenantIdError,
} from '../../src/middleware/tenant-extractor';
import { DEFAULT_TENANT_ID } from '../../src/tenant/types';

describe('assertValidTenantId', () => {
  it('accepts simple alphanumeric ids', () => {
    expect(assertValidTenantId('tenant1')).toBe('tenant1');
    expect(assertValidTenantId('acme-corp')).toBe('acme-corp');
    expect(assertValidTenantId('t_1')).toBe('t_1');
  });

  it('accepts UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(assertValidTenantId(uuid)).toBe(uuid);
  });

  it('accepts the default tenant id', () => {
    expect(assertValidTenantId(DEFAULT_TENANT_ID)).toBe(DEFAULT_TENANT_ID);
  });

  it('trims surrounding whitespace', () => {
    expect(assertValidTenantId('  abc  ')).toBe('abc');
  });

  it('rejects empty string', () => {
    expect(() => assertValidTenantId('')).toThrow(TenantIdError);
    expect(() => assertValidTenantId('   ')).toThrow(/empty/);
  });

  it('rejects ids longer than the max', () => {
    const tooLong = 'a'.repeat(MAX_TENANT_ID_LENGTH + 1);
    expect(() => assertValidTenantId(tooLong)).toThrow(/exceeds max length/);
  });

  it('accepts an id exactly at the max length', () => {
    const edge = 'a'.repeat(MAX_TENANT_ID_LENGTH);
    expect(assertValidTenantId(edge)).toBe(edge);
  });

  it('rejects ids starting with hyphen or underscore', () => {
    expect(() => assertValidTenantId('-leading')).toThrow(TenantIdError);
    expect(() => assertValidTenantId('_leading')).toThrow(TenantIdError);
  });

  it.each([
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['dot', 'a.b'],
    ['space', 'a b'],
    ['null byte', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['parenthesis', 'a(b)'],
    ['unicode', 'téenant'],
  ])('rejects %s metacharacter (%s)', (_label, value) => {
    expect(() => assertValidTenantId(value)).toThrow(TenantIdError);
  });

  it('attaches a structured error code for invalid ids', () => {
    try {
      assertValidTenantId('a/b');
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TenantIdError);
      expect((err as TenantIdError).code).toBe('invalid');
    }
  });
});

describe('extractTenantId', () => {
  it('returns DEFAULT_TENANT_ID when header is absent (non-strict)', () => {
    expect(extractTenantId({})).toBe(DEFAULT_TENANT_ID);
  });

  it('reads the lowercase header directly (node style)', () => {
    expect(extractTenantId({ [TENANT_HEADER]: 'acme' })).toBe('acme');
  });

  it('is case-insensitive on the header name', () => {
    expect(extractTenantId({ 'X-Tenant-Id': 'acme' })).toBe('acme');
    expect(extractTenantId({ 'X-TENANT-ID': 'acme' })).toBe('acme');
  });

  it('unwraps array-valued headers (IncomingHttpHeaders)', () => {
    expect(extractTenantId({ [TENANT_HEADER]: ['t1', 't2'] })).toBe('t1');
  });

  it('validates the header value', () => {
    expect(() => extractTenantId({ [TENANT_HEADER]: 'a/b' })).toThrow(
      TenantIdError,
    );
  });

  it('throws "missing" when required and header absent', () => {
    try {
      extractTenantId({}, { required: true });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TenantIdError);
      expect((err as TenantIdError).code).toBe('missing');
    }
  });

  it('does NOT treat empty string as "missing" — surfaces invalid', () => {
    try {
      extractTenantId({ [TENANT_HEADER]: '' }, { required: true });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TenantIdError);
      expect((err as TenantIdError).code).toBe('invalid');
    }
  });

  it('treats undefined array as missing', () => {
    expect(extractTenantId({ [TENANT_HEADER]: undefined })).toBe(
      DEFAULT_TENANT_ID,
    );
  });
});
