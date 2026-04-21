/// <reference types="jest" />
// Tests for HTTPTransport.resolveAuthMode — Codex P1 regression guard (PR #28).
// When OPENCHROME_AUTH_MODE=legacy-shared-token is set, the transport must fail
// closed if no token is configured instead of silently downgrading to `disabled`.

import { HTTPTransport } from '../../src/transports/http';

describe('HTTPTransport.resolveAuthMode', () => {
  const ORIGINAL_ENV = process.env.OPENCHROME_AUTH_MODE;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.OPENCHROME_AUTH_MODE;
    } else {
      process.env.OPENCHROME_AUTH_MODE = ORIGINAL_ENV;
    }
  });

  it('throws when OPENCHROME_AUTH_MODE=legacy-shared-token is set but no token is configured', () => {
    process.env.OPENCHROME_AUTH_MODE = 'legacy-shared-token';
    expect(() => HTTPTransport.resolveAuthMode(undefined, undefined)).toThrow(
      /OPENCHROME_AUTH_MODE=legacy-shared-token requires a shared token/,
    );
  });

  it('throws even when an ApiKeyStore is also available (env flag must win explicitly)', () => {
    process.env.OPENCHROME_AUTH_MODE = 'legacy-shared-token';
    const fakeStore = {} as Parameters<typeof HTTPTransport.resolveAuthMode>[1];
    expect(() => HTTPTransport.resolveAuthMode(undefined, fakeStore)).toThrow();
  });

  it('returns legacy mode when env + token are both set (happy path)', () => {
    process.env.OPENCHROME_AUTH_MODE = 'legacy-shared-token';
    const mode = HTTPTransport.resolveAuthMode('shared-secret', undefined);
    expect(mode.kind).toBe('legacy-shared-token');
  });

  it('returns api-key mode when store is provided and no env flag is set', () => {
    delete process.env.OPENCHROME_AUTH_MODE;
    const fakeStore = {} as Parameters<typeof HTTPTransport.resolveAuthMode>[1];
    const mode = HTTPTransport.resolveAuthMode(undefined, fakeStore);
    expect(mode.kind).toBe('api-key');
  });

  it('returns legacy mode for backwards-compat when only authToken is passed (no env)', () => {
    delete process.env.OPENCHROME_AUTH_MODE;
    const mode = HTTPTransport.resolveAuthMode('legacy-token', undefined);
    expect(mode.kind).toBe('legacy-shared-token');
  });

  it('returns disabled when nothing is configured', () => {
    delete process.env.OPENCHROME_AUTH_MODE;
    const mode = HTTPTransport.resolveAuthMode(undefined, undefined);
    expect(mode.kind).toBe('disabled');
  });
});
