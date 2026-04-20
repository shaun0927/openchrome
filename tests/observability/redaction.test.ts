import {
  BUILTIN_REDACTION_CONFIG,
  REDACTED,
  redactArgs,
  type RedactionConfig,
} from '../../src/observability/redaction';

const cfg: RedactionConfig = {
  defaultSensitiveFieldNames: [...BUILTIN_REDACTION_CONFIG.defaultSensitiveFieldNames],
  tools: {
    'cookies.set': [
      { path: 'value', mode: 'hash' },
      { path: 'cookies[*].value', mode: 'hash' },
    ],
    fill_form: [
      { path: 'fields[*].value', mode: 'redactIfSensitiveName' },
    ],
    javascript_tool: [
      { path: 'code', mode: 'truncate', maxBytes: 16 },
    ],
  },
};

describe('redactArgs', () => {
  test('heuristic redacts password field by name', () => {
    const out = redactArgs('fill_form', { username: 'u', password: 'p@ss' }, cfg);
    expect(out.redacted.password).toBe(REDACTED);
    expect(out.redacted.username).toBe('u');
  });

  test('per-tool rule hashes cookie value', () => {
    const args = { name: 'session', value: 'super-secret' };
    const out = redactArgs('cookies.set', args, cfg);
    const v = out.redacted.value as string;
    expect(v.startsWith('sha256:')).toBe(true);
    expect(v).not.toContain('super-secret');
  });

  test('array wildcard rule redacts sensitive field in array', () => {
    const args = {
      fields: [
        { name: 'email', value: 'a@b.c' },
        { name: 'password', value: 'hunter2' },
      ],
    };
    const out = redactArgs('fill_form', args, cfg);
    const fields = out.redacted.fields as Array<{ name: string; value: string }>;
    expect(fields[0].value).toBe('a@b.c');
    expect(fields[1].value).toBe(REDACTED);
  });

  test('truncate keeps prefix and adds hash', () => {
    const args = { code: 'console.error("a very long script body")' };
    const out = redactArgs('javascript_tool', args, cfg);
    const code = out.redacted.code as { preview: string; hash: string; truncated: boolean };
    expect(code.truncated).toBe(true);
    expect(code.preview.length).toBeLessThanOrEqual(16);
    expect(code.hash.startsWith('sha256:')).toBe(true);
  });

  test('original args object is not mutated', () => {
    const args = { password: 'p', nested: { token: 't' } };
    const snapshot = JSON.parse(JSON.stringify(args));
    redactArgs('unknown_tool', args, cfg);
    expect(args).toEqual(snapshot);
  });

  test('argsHash stays stable across redaction', () => {
    const args = { password: 'p', name: 'x' };
    const a = redactArgs('unknown', args, cfg);
    const b = redactArgs('unknown', args, cfg);
    expect(a.argsHash).toBe(b.argsHash);
    expect(a.argsHash.startsWith('sha256:')).toBe(true);
  });

  test('unknown tool still applies name-based heuristic', () => {
    const out = redactArgs('no_such_tool', { Authorization: 'Bearer xyz' }, cfg);
    expect(out.redacted.Authorization).toBe(REDACTED);
  });

  test('heuristic redacts {name, value} form-field shape without per-tool rule', () => {
    // Reproduces the missing-config fallback scenario: even when no per-tool
    // rule exists for the form payload, the {name: "password", value: "..."}
    // shape must not leak.
    const out = redactArgs(
      'no_rule_tool',
      {
        fields: [
          { name: 'email', value: 'a@b.c' },
          { name: 'password', value: 'hunter2' },
          { name: 'apiKey', value: 'k-123' },
        ],
      },
      BUILTIN_REDACTION_CONFIG,
    );
    const fields = out.redacted.fields as Array<{ name: string; value: string }>;
    expect(fields[0].value).toBe('a@b.c');
    expect(fields[1].value).toBe(REDACTED);
    expect(fields[2].value).toBe(REDACTED);
  });

  test('truncate enforces byte cap, not character count, on multi-byte input', () => {
    // Each Korean char encodes to 3 UTF-8 bytes. With maxBytes=16, a 10-char
    // string would be 30 bytes; truncation must cap by bytes (≤16), not by
    // string length, and must not split a multi-byte code point.
    const args = { code: '한글한글한글한글한글' };
    const out = redactArgs('javascript_tool', args, cfg);
    const code = out.redacted.code as { preview: string; hash: string; truncated: boolean };
    expect(code.truncated).toBe(true);
    expect(Buffer.byteLength(code.preview, 'utf8')).toBeLessThanOrEqual(16);
    // No replacement chars from a split multi-byte sequence.
    expect(code.preview).not.toContain('\uFFFD');
  });

  test('argsHash is canonical (insertion-order independent)', () => {
    const a = redactArgs('any', { a: 1, b: 2, nested: { x: 1, y: 2 } }, cfg);
    const b = redactArgs('any', { nested: { y: 2, x: 1 }, b: 2, a: 1 }, cfg);
    expect(a.argsHash).toBe(b.argsHash);
  });
});
