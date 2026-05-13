import { setGlobalConfig } from '../../src/config/global';
import {
  DomainPolicyError,
  assertDomainAllowed,
  getDomainPolicyBlockedResult,
  isDomainBlocked,
} from '../../src/security/domain-guard';

describe('domain guard allow-host policy (#835)', () => {
  const oldEnv = process.env.OPENCHROME_ALLOW_HOSTS;

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.OPENCHROME_ALLOW_HOSTS;
    else process.env.OPENCHROME_ALLOW_HOSTS = oldEnv;
    setGlobalConfig({ security: { blocked_domains: [], allow_hosts: [] } });
  });

  test('is default-allow when no allowlist or blocklist is configured', () => {
    setGlobalConfig({ security: { blocked_domains: [], allow_hosts: [] } });
    expect(() => assertDomainAllowed('https://attacker.test')).not.toThrow();
  });

  test('allows exact host and blocks other hosts with structured result', () => {
    setGlobalConfig({ security: { allow_hosts: ['example.com'] } });
    expect(() => assertDomainAllowed('https://example.com/path')).not.toThrow();
    const blocked = getDomainPolicyBlockedResult('https://attacker.com/');
    expect(blocked).toEqual({
      blocked: true,
      reason: 'host-not-allowed',
      attemptedUrl: 'https://attacker.com/',
      matchedPattern: null,
    });
    expect(() => assertDomainAllowed('https://attacker.com/')).toThrow(DomainPolicyError);
  });

  test('leading wildcard matches subdomains but not apex', () => {
    setGlobalConfig({ security: { allow_hosts: ['*.github.com'] } });
    expect(() => assertDomainAllowed('https://api.github.com/')).not.toThrow();
    expect(getDomainPolicyBlockedResult('https://github.com/')?.reason).toBe('host-not-allowed');
  });

  test('blocks unsafe schemes when allowlist is active', () => {
    setGlobalConfig({ security: { allow_hosts: ['example.com'] } });
    expect(getDomainPolicyBlockedResult('file:///etc/passwd')).toEqual({
      blocked: true,
      reason: 'scheme-not-allowed',
      attemptedUrl: 'file:///etc/passwd',
      matchedPattern: null,
    });
  });

  test('normalizes IDN allowlist patterns to punycode', () => {
    setGlobalConfig({ security: { allow_hosts: ['bücher.example'] } });
    expect(() => assertDomainAllowed('https://xn--bcher-kva.example/')).not.toThrow();
    expect(getDomainPolicyBlockedResult('https://paypal.com/')?.reason).toBe('host-not-allowed');
  });

  test('requires exact IP literal matches', () => {
    setGlobalConfig({ security: { allow_hosts: ['127.0.0.1'] } });
    expect(() => assertDomainAllowed('http://127.0.0.1:3000')).not.toThrow();
    expect(getDomainPolicyBlockedResult('http://127.0.0.2/')?.reason).toBe('host-not-allowed');
  });

  test('OPENCHROME_ALLOW_HOSTS composes with configured allowlist', () => {
    process.env.OPENCHROME_ALLOW_HOSTS = 'env.example';
    setGlobalConfig({ security: { allow_hosts: ['cli.example'] } });
    expect(() => assertDomainAllowed('https://cli.example')).not.toThrow();
    expect(() => assertDomainAllowed('https://env.example')).not.toThrow();
    expect(getDomainPolicyBlockedResult('https://other.example')?.reason).toBe('host-not-allowed');
  });

  test('preserves legacy blocklist behavior', () => {
    setGlobalConfig({ security: { blocked_domains: ['*.bank.com'], allow_hosts: [] } });
    expect(isDomainBlocked('https://login.bank.com')).toBe(true);
    expect(() => assertDomainAllowed('https://login.bank.com')).toThrow(DomainPolicyError);
    expect(() => assertDomainAllowed('https://example.com')).not.toThrow();
  });
});
