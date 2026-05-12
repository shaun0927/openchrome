import {
  REDACTED,
  redactTraceEvent,
  redactValue,
  scrubString,
} from '../../../src/core/trace/redactor';

describe('trace redactor — scrubString patterns', () => {
  test('redacts JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dGVzdHRlc3R0ZXN0';
    expect(scrubString(`token=${jwt}`)).not.toContain(jwt);
    expect(scrubString(`Header: ${jwt}`)).toContain(REDACTED);
  });

  test('redacts AWS access key', () => {
    expect(scrubString('AKIAIOSFODNN7EXAMPLE in body')).toContain(REDACTED);
    expect(scrubString('AKIAIOSFODNN7EXAMPLE in body')).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('redacts Bearer/Basic/Token auth schemes', () => {
    const out = scrubString('Authorization: Bearer abc123def456');
    expect(out).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  test('matches auth schemes case-insensitively (HTTP tokens are case-insensitive)', () => {
    expect(scrubString('authorization: bearer abc123def456')).toBe(`authorization: bearer ${REDACTED}`);
    expect(scrubString('Authorization: BEARER abc123def456')).toBe(`Authorization: BEARER ${REDACTED}`);
    expect(scrubString('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(`Authorization: Basic ${REDACTED}`);
    expect(scrubString('authorization: token abc123def456')).toBe(`authorization: token ${REDACTED}`);
  });

  test('redacts SSN-like 9-digit pattern', () => {
    expect(scrubString('SSN 123-45-6789 here')).toContain(REDACTED);
  });

  test('redacts long hex tokens (32+)', () => {
    const hex = 'a'.repeat(40);
    expect(scrubString(`token=${hex}`)).not.toContain(hex);
  });

  test('redacts URL-encoded credential params, preserves param name', () => {
    const out = scrubString('https://x.com/login?username=alice&password=hunter2&next=/');
    expect(out).toContain('username=alice');
    expect(out).toContain(`password=${REDACTED}`);
    expect(out).not.toContain('hunter2');
  });

  test('leaves benign strings untouched', () => {
    expect(scrubString('hello world')).toBe('hello world');
    expect(scrubString('https://example.com/page')).toBe('https://example.com/page');
  });

  test('handles multiple patterns in same string', () => {
    const dirty = 'auth=Bearer xyz789abc123def AKIAIOSFODNN7EXAMPLE end';
    const clean = scrubString(dirty);
    expect(clean).not.toContain('xyz789abc123def');
    expect(clean).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('trace redactor — sensitive object keys', () => {
  test('redacts sensitive keys regardless of value', () => {
    const out = redactValue({ password: 'p', token: 't', username: 'u' }) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.username).toBe('u');
  });

  test('redacts sensitive keys at any depth', () => {
    const out = redactValue({ outer: { inner: { api_key: 'sk_live_xyz' } } }) as {
      outer: { inner: { api_key: unknown } };
    };
    expect(out.outer.inner.api_key).toBe(REDACTED);
  });

  test('redacts inside arrays', () => {
    const out = redactValue({
      fields: [
        { name: 'email', value: 'a@b.c' },
        { name: 'password', value: 'hunter2' },
      ],
    }) as { fields: Array<{ name: string; value: unknown }> };
    expect(out.fields[0].value).toBe('a@b.c');
    expect(out.fields[1].value).toBe(REDACTED); // password key match
  });
});

describe('trace redactor — HTTP headers', () => {
  test('redacts Authorization header (object form)', () => {
    const out = redactValue({ headers: { Authorization: 'Bearer abc', 'X-Custom': 'ok' } }) as {
      headers: Record<string, string>;
    };
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers['X-Custom']).toBe('ok');
  });

  test('redacts Authorization header (array-of-{name,value} form)', () => {
    const out = redactValue({
      headers: [
        { name: 'Authorization', value: 'Bearer secret' },
        { name: 'Accept', value: 'application/json' },
      ],
    }) as { headers: Array<{ name: string; value: string }> };
    expect(out.headers[0].value).toBe(REDACTED);
    expect(out.headers[1].value).toBe('application/json');
  });

  test('redacts Set-Cookie / Cookie wholesale', () => {
    const out = redactValue({
      headers: { Cookie: 'sid=foo; csrf=bar', 'Set-Cookie': 'sid=foo; HttpOnly' },
    }) as { headers: Record<string, string> };
    expect(out.headers.Cookie).toBe(REDACTED);
    expect(out.headers['Set-Cookie']).toBe(REDACTED);
  });

  test('case-insensitive header name match', () => {
    const out = redactValue({ headers: { authorization: 'Bearer abc' } }) as {
      headers: Record<string, string>;
    };
    expect(out.headers.authorization).toBe(REDACTED);
  });
});

describe('trace redactor — redactTraceEvent envelope', () => {
  test('preserves ts/seq/kind, scrubs body', () => {
    const event = {
      ts: 1700000000000,
      seq: 42,
      kind: 'Network.requestWillBeSent',
      body: {
        request: {
          url: 'https://x.com/login?password=hunter2',
          headers: { Authorization: 'Bearer secret_xyz' },
        },
      },
    };
    const out = redactTraceEvent(event);
    expect(out.ts).toBe(1700000000000);
    expect(out.seq).toBe(42);
    expect(out.kind).toBe('Network.requestWillBeSent');
    const req = (out.body as { request: { url: string; headers: Record<string, string> } }).request;
    expect(req.url).toContain(`password=${REDACTED}`);
    expect(req.url).not.toContain('hunter2');
    expect(req.headers.Authorization).toBe(REDACTED);
  });

  test('does not mutate the input event', () => {
    const event = {
      ts: 1,
      seq: 1,
      kind: 'k',
      body: { password: 'hunter2', other: { token: 't' } },
    };
    redactTraceEvent(event);
    expect(event.body).toEqual({ password: 'hunter2', other: { token: 't' } });
  });
});

describe('trace redactor — planted-credential test (acceptance from #701 v2)', () => {
  // Mirrors the AC: 7 credential patterns must produce zero raw matches in
  // the redacted output.
  test('all 7 patterns scrubbed', () => {
    const planted = {
      a: { url: 'https://x/?password=hunter2' },
      b: { headers: { Authorization: 'Bearer abc.def.ghi' } },
      c: { headers: { 'Set-Cookie': 'sid=raw_value' } },
      d: { keyId: 'AKIAIOSFODNN7EXAMPLE' },
      e: {
        body:
          'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dGVzdHRlc3R0ZXN0',
      },
      f: { hexBlob: 'a'.repeat(40) },
      g: { ssn: '123-45-6789' },
    };
    const out = JSON.stringify(redactValue(planted));
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('Bearer abc.def.ghi');
    expect(out).not.toContain('raw_value');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).not.toContain('a'.repeat(40));
    expect(out).not.toContain('123-45-6789');
  });
});
