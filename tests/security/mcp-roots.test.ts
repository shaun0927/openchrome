import {
  assertUrlAllowedBySessionRoots,
  clearAllSessionMcpRoots,
  parseMcpRoots,
  setSessionMcpRoots,
} from '../../src/security/mcp-roots';

describe('MCP roots network narrowing (#880)', () => {
  afterEach(() => clearAllSessionMcpRoots());

  test('parses only https roots for network enforcement', () => {
    const parsed = parseMcpRoots({
      roots: [
        { uri: 'https://example.com' },
        { uri: 'https://*.staging.example.com' },
        { uri: 'file:///tmp/task-a' },
        { uri: 'openchrome://future' },
      ],
    });

    expect(parsed.raw).toHaveLength(4);
    expect(parsed.network).toEqual([
      { uri: 'https://example.com', protocol: 'https:', host: 'example.com', wildcardSubdomains: false },
      { uri: 'https://*.staging.example.com', protocol: 'https:', host: 'staging.example.com', wildcardSubdomains: true },
    ]);
  });

  test('allows matching exact and wildcard subdomain roots', () => {
    setSessionMcpRoots('mcp-a', {
      roots: [
        { uri: 'https://example.com' },
        { uri: 'https://*.staging.example.com' },
      ],
    });

    expect(() => assertUrlAllowedBySessionRoots('mcp-a', 'https://example.com/path')).not.toThrow();
    expect(() => assertUrlAllowedBySessionRoots('mcp-a', 'https://foo.staging.example.com/path')).not.toThrow();
  });

  test('denies non-matching hosts without widening static policy', () => {
    setSessionMcpRoots('mcp-a', { roots: [{ uri: 'https://allowed.example.com' }] });

    expect(() => assertUrlAllowedBySessionRoots('mcp-a', 'https://blocked.example.com/path')).toThrow(/MCP roots narrowing/);
  });

  test('falls back to unchanged behavior when no applicable network roots exist', () => {
    setSessionMcpRoots('mcp-a', { roots: [{ uri: 'file:///tmp/task-a' }] });

    expect(() => assertUrlAllowedBySessionRoots('mcp-a', 'https://any.example.com')).not.toThrow();
  });
});
