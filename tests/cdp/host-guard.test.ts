import {
  assertHostAllowed,
  envAllowRemote,
  isLoopbackHost,
  parseEndpoint,
  RemoteHostRefusedError,
  resetHostGuardAuditLatch,
  wouldRefuse,
} from '../../src/cdp/host-guard';

describe('CDP host guard (P2)', () => {
  const savedEnv = process.env.OPENCHROME_ALLOW_REMOTE_CDP;
  beforeEach(() => {
    delete process.env.OPENCHROME_ALLOW_REMOTE_CDP;
    resetHostGuardAuditLatch();
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.OPENCHROME_ALLOW_REMOTE_CDP;
    else process.env.OPENCHROME_ALLOW_REMOTE_CDP = savedEnv;
  });

  describe('parseEndpoint', () => {
    test('parses ws://127.0.0.1:9222', () => {
      const p = parseEndpoint('ws://127.0.0.1:9222/devtools/browser/abc');
      expect(p.hostname).toBe('127.0.0.1');
      expect(p.port).toBe('9222');
      expect(p.protocol).toBe('ws:');
    });
    test('unwraps bracketed IPv6', () => {
      const p = parseEndpoint('ws://[::1]:9222/devtools/browser/abc');
      expect(p.hostname).toBe('::1');
    });
    test('rejects empty string', () => {
      expect(() => parseEndpoint('')).toThrow(TypeError);
    });
    test('rejects malformed URL', () => {
      expect(() => parseEndpoint('not-a-url')).toThrow();
    });
  });

  describe('isLoopbackHost', () => {
    test.each([
      ['localhost', true],
      ['LocalHost', true],
      ['127.0.0.1', true],
      ['127.0.0.2', true],
      ['127.255.255.254', true],
      ['::1', true],
      ['0.0.0.0', false],
      ['10.0.0.1', false],
      ['192.168.1.1', false],
      ['100.105.164.20', false], // Tailscale range
      ['8.8.8.8', false],
      ['example.com', false],
      ['128.0.0.1', false],
    ])('%s → %s', (host, expected) => {
      expect(isLoopbackHost(host)).toBe(expected);
    });
  });

  describe('assertHostAllowed', () => {
    test('loopback passes without opt-in', () => {
      expect(() => assertHostAllowed('ws://127.0.0.1:9222/devtools/browser/x')).not.toThrow();
      expect(() => assertHostAllowed('ws://localhost:9222/x')).not.toThrow();
      expect(() => assertHostAllowed('ws://[::1]:9222/x')).not.toThrow();
    });

    test('non-loopback throws RemoteHostRefusedError by default', () => {
      let caught: unknown;
      try {
        assertHostAllowed('ws://100.64.0.5:9222/devtools/browser/x');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RemoteHostRefusedError);
      const err = caught as RemoteHostRefusedError;
      expect(err.code).toBe('remote_host_refused');
      expect(err.hostname).toBe('100.64.0.5');
      expect(err.protocol).toBe('ws:');
      expect(err.message).toContain('--allow-remote');
    });

    test('opts.allowRemote=true bypasses refuse', () => {
      const logs: string[] = [];
      expect(() =>
        assertHostAllowed('ws://10.0.0.5:9222/devtools/browser/x', {
          allowRemote: true,
          logger: (m) => logs.push(m),
        }),
      ).not.toThrow();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('--allow-remote is ACTIVE');
      expect(logs[0]).toContain('10.0.0.5');
    });

    test('audit line is emitted only once across calls', () => {
      const logs: string[] = [];
      assertHostAllowed('ws://10.0.0.5:9222/x', { allowRemote: true, logger: (m) => logs.push(m) });
      assertHostAllowed('ws://10.0.0.6:9222/x', { allowRemote: true, logger: (m) => logs.push(m) });
      expect(logs).toHaveLength(1);
    });

    test('env OPENCHROME_ALLOW_REMOTE_CDP=1 bypasses refuse', () => {
      process.env.OPENCHROME_ALLOW_REMOTE_CDP = '1';
      const logs: string[] = [];
      expect(() =>
        assertHostAllowed('ws://192.168.1.10:9222/x', { logger: (m) => logs.push(m) }),
      ).not.toThrow();
      expect(logs[0]).toContain('192.168.1.10');
    });

    test('env values that are not truthy do NOT bypass', () => {
      process.env.OPENCHROME_ALLOW_REMOTE_CDP = 'no';
      expect(() => assertHostAllowed('ws://192.168.1.10:9222/x')).toThrow(RemoteHostRefusedError);
    });
  });

  describe('envAllowRemote', () => {
    test.each([
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      ['on', true],
      ['0', false],
      ['false', false],
      ['', false],
    ])('env=%s → %s', (v, expected) => {
      process.env.OPENCHROME_ALLOW_REMOTE_CDP = v;
      expect(envAllowRemote()).toBe(expected);
    });
    test('unset env → false', () => {
      expect(envAllowRemote()).toBe(false);
    });
  });

  describe('wouldRefuse', () => {
    test('loopback → false', () => {
      expect(wouldRefuse('ws://127.0.0.1:9222/x')).toBe(false);
    });
    test('remote → true', () => {
      expect(wouldRefuse('ws://10.0.0.5:9222/x')).toBe(true);
    });
    test('malformed → true (fail-closed)', () => {
      expect(wouldRefuse('garbage')).toBe(true);
    });
  });
});
