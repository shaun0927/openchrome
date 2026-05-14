import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  assertFilePathAllowedBySessionRoots,
  assertUrlAllowedBySessionRoots,
  clearAllSessionMcpRoots,
  parseMcpRoots,
  setSessionMcpRoots,
} from '../../src/security/mcp-roots';

describe('MCP roots network narrowing (#880)', () => {
  const fileRootPath = path.resolve('tmp', 'task-a');
  const fileRootUri = pathToFileURL(fileRootPath).href;
  const siblingPath = path.resolve('tmp', 'task-b', 'page.pdf');
  const similarPrefixPath = path.resolve('tmp', 'task-a-sibling', 'page.pdf');

  afterEach(() => clearAllSessionMcpRoots());

  test('parses only https roots for network enforcement', () => {
    const parsed = parseMcpRoots({
      roots: [
        { uri: 'https://example.com' },
        { uri: 'https://*.staging.example.com' },
        { uri: fileRootUri },
        { uri: 'openchrome://future' },
      ],
    });

    expect(parsed.raw).toHaveLength(4);
    expect(parsed.network).toEqual([
      { uri: 'https://example.com', protocol: 'https:', host: 'example.com', wildcardSubdomains: false },
      { uri: 'https://*.staging.example.com', protocol: 'https:', host: 'staging.example.com', wildcardSubdomains: true },
    ]);
    expect(parsed.file).toEqual([
      { uri: fileRootUri, path: fileRootPath },
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
    setSessionMcpRoots('mcp-a', { roots: [{ uri: fileRootUri }] });

    expect(() => assertUrlAllowedBySessionRoots('mcp-a', 'https://any.example.com')).not.toThrow();
  });

  test('allows file outputs inside file roots and rejects siblings', () => {
    setSessionMcpRoots('mcp-a', { roots: [{ uri: fileRootUri }] });

    expect(() => assertFilePathAllowedBySessionRoots('mcp-a', path.join(fileRootPath, 'page.pdf'))).not.toThrow();
    expect(() => assertFilePathAllowedBySessionRoots('mcp-a', path.join(fileRootPath, 'nested', 'page.pdf'))).not.toThrow();
    expect(() => assertFilePathAllowedBySessionRoots('mcp-a', siblingPath)).toThrow(/MCP roots narrowing/);
    expect(() => assertFilePathAllowedBySessionRoots('mcp-a', similarPrefixPath)).toThrow(/MCP roots narrowing/);
  });

  test('falls back to unchanged behavior when no applicable file roots exist', () => {
    setSessionMcpRoots('mcp-a', { roots: [{ uri: 'https://example.com' }] });

    expect(() => assertFilePathAllowedBySessionRoots('mcp-a', path.resolve('tmp', 'anywhere', 'page.pdf'))).not.toThrow();
  });
});
