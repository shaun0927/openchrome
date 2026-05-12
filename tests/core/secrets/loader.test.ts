/// <reference types="jest" />
/**
 * Secret loader tests (#834).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseDotenv,
  makeSecretStore,
  loadSecretsFromFile,
  SecretLoadError,
  MAX_SECRETS,
} from '../../../src/core/secrets/loader';

describe('parseDotenv', () => {
  test('parses single KEY=value line', () => {
    const map = parseDotenv('API_KEY=abc123');
    expect(map.get('API_KEY')).toBe('abc123');
    expect(map.size).toBe(1);
  });

  test('ignores blank lines and # comments', () => {
    const map = parseDotenv('\n# a comment\n\nFOO=bar\n');
    expect(map.size).toBe(1);
    expect(map.get('FOO')).toBe('bar');
  });

  test('strips matching surrounding quotes (single and double)', () => {
    const map = parseDotenv('A="dbl"\nB=\'sng\'');
    expect(map.get('A')).toBe('dbl');
    expect(map.get('B')).toBe('sng');
  });

  test('preserves # inside value (no inline comment stripping)', () => {
    const map = parseDotenv('SEED=abc#def#ghi');
    expect(map.get('SEED')).toBe('abc#def#ghi');
  });

  test('handles CRLF line endings', () => {
    const map = parseDotenv('A=1\r\nB=2\r\n');
    expect(map.get('A')).toBe('1');
    expect(map.get('B')).toBe('2');
  });

  test('tolerates BOM', () => {
    const map = parseDotenv('﻿A=1');
    expect(map.get('A')).toBe('1');
  });

  test('throws SecretLoadError on missing =', () => {
    expect(() => parseDotenv('no_equals_here')).toThrow(SecretLoadError);
    try {
      parseDotenv('ok=1\nbad_line');
    } catch (e) {
      expect((e as SecretLoadError).line).toBe(2);
      expect((e as SecretLoadError).message).toMatch(/missing "="/);
    }
  });

  test('throws on invalid key shape', () => {
    expect(() => parseDotenv('1BAD=x')).toThrow(SecretLoadError);
    expect(() => parseDotenv('bad-key=x')).toThrow(SecretLoadError);
  });

  test('throws on empty key', () => {
    expect(() => parseDotenv('=value')).toThrow(SecretLoadError);
  });

  test('last write wins on duplicate keys (with warning)', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const map = parseDotenv('A=1\nA=2');
    expect(map.get('A')).toBe('2');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('hard cap at MAX_SECRETS', () => {
    const lines: string[] = [];
    for (let i = 0; i <= MAX_SECRETS; i++) {
      lines.push(`K${i}=v${i}`);
    }
    expect(() => parseDotenv(lines.join('\n'))).toThrow(SecretLoadError);
  });
});

describe('makeSecretStore', () => {
  test('size, get, has work', () => {
    const store = makeSecretStore(new Map([['A', '1'], ['B', '2']]));
    expect(store.size).toBe(2);
    expect(store.get('A')).toBe('1');
    expect(store.has('B')).toBe(true);
    expect(store.has('Z')).toBe(false);
    expect(store.get('Z')).toBeUndefined();
  });

  test('iterators expose entries / values / names', () => {
    const store = makeSecretStore(new Map([['A', '1']]));
    expect(Array.from(store.entries())).toEqual([['A', '1']]);
    expect(Array.from(store.values())).toEqual(['1']);
    expect(Array.from(store.names())).toEqual(['A']);
  });

  test('copies the source map (mutation isolation)', () => {
    const src = new Map([['A', '1']]);
    const store = makeSecretStore(src);
    src.set('A', 'mutated');
    expect(store.get('A')).toBe('1');
  });
});

describe('loadSecretsFromFile', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-secrets-test-'));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reads a valid dotenv file', () => {
    const p = path.join(tmpDir, 'ok.env');
    fs.writeFileSync(p, 'TEST_PW=hunter2\nTEST_TOTP=987654\n');
    const store = loadSecretsFromFile(p);
    expect(store.size).toBe(2);
    expect(store.get('TEST_PW')).toBe('hunter2');
  });

  test('SecretLoadError includes 1-based line number on malformed file', () => {
    const p = path.join(tmpDir, 'bad.env');
    fs.writeFileSync(p, 'OK=1\nbad-shape-no-equals\n');
    expect(() => loadSecretsFromFile(p)).toThrow(/secrets:2:/);
  });

  test('throws on missing file (ENOENT)', () => {
    expect(() => loadSecretsFromFile(path.join(tmpDir, 'nope.env')))
      .toThrow(/ENOENT/);
  });
});
