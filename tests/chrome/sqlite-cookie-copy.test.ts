/**
 * Tests for atomic SQLite cookie copy module
 *
 * Covers:
 *   - 3-tier fallback chain (better-sqlite3 → sqlite3-cli → file-copy → none)
 *   - Source file missing guard
 *   - Real filesystem copy with WAL file exclusion
 *   - Warning messages on fallback and failure
 *   - Path safety with single-quote characters
 */

jest.unmock('../../src/chrome/sqlite-cookie-copy');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock child_process so we can control execSync per-test
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFileSync: jest.fn(),
  };
});

import { execFileSync } from 'child_process';
import { copyCookiesAtomic, _deps } from '../../src/chrome/sqlite-cookie-copy';
const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory that contains a minimal `Cookies` file. */
function makeTmpWithCookies(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-src-'));
  fs.writeFileSync(path.join(dir, 'Cookies'), 'fake-sqlite-db-content');
  return dir;
}

/** Create an empty destination temp directory. */
function makeTmpDest(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-dst-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('copyCookiesAtomic', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let betterSqliteSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockExecFileSync.mockReset();
    // By default, make Tier 1 fail so most tests exercise Tier 2/3
    betterSqliteSpy = jest
      .spyOn(_deps, 'attemptBetterSqlite3Copy')
      .mockImplementation(() => {
        throw new Error('better-sqlite3 not available');
      });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    betterSqliteSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 1. Source file missing
  // -------------------------------------------------------------------------

  describe('source file missing', () => {
    it('returns { method: none, success: false } with a warning when Cookies file absent', () => {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-nosrc-'));
      const dstDir = makeTmpDest();

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.method).toBe('none');
        expect(result.success).toBe(false);
        expect(result.warning).toBeTruthy();
        expect(result.warning).toMatch(/not found/i);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('returns { method: none, success: false } when sourceDefaultDir does not exist', () => {
      const result = copyCookiesAtomic('/nonexistent/path/Default', '/tmp/oc-test-dst-fake');

      expect(result.method).toBe('none');
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tier 1 — better-sqlite3
  // -------------------------------------------------------------------------

  describe('Tier 1: better-sqlite3', () => {
    it('returns { method: better-sqlite3, success: true } when better-sqlite3 succeeds', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      // Make Tier 1 succeed (no throw)
      betterSqliteSpy.mockImplementation(() => {});

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.method).toBe('better-sqlite3');
        expect(result.success).toBe(true);
        expect(result.warning).toBeUndefined();
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('does not call execSync when better-sqlite3 succeeds', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      betterSqliteSpy.mockImplementation(() => {});

      try {
        copyCookiesAtomic(srcDir, dstDir);
        expect(mockExecFileSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Tier 2 — sqlite3 CLI
  // -------------------------------------------------------------------------

  describe('Tier 2: sqlite3-cli', () => {
    it('returns { method: sqlite3-cli, success: true } when execSync succeeds', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      // Tier 1 fails (default), Tier 2 succeeds
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.method).toBe('sqlite3-cli');
        expect(result.success).toBe(true);
        expect(result.warning).toBeUndefined();
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('calls execFileSync with sqlite3 backup command containing source and dest paths', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      mockExecFileSync.mockReturnValue(Buffer.from(''));

      try {
        copyCookiesAtomic(srcDir, dstDir);

        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
        const cmd = mockExecFileSync.mock.calls[0][0] as string;
        const args = mockExecFileSync.mock.calls[0][1] as string[];
        expect(cmd).toBe('sqlite3');
        expect(args[0]).toBe(path.join(srcDir, 'Cookies'));
        expect(args[1]).toContain('.backup');
        expect(args[1]).toContain(path.join(dstDir, 'Cookies'));
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('falls through to tier 3 when execSync throws', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      mockExecFileSync.mockImplementation(() => {
        throw new Error('sqlite3: command not found');
      });

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.method).toBe('file-copy');
        expect(result.success).toBe(true);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. Tier 3 — file-copy (real filesystem)
  // -------------------------------------------------------------------------

  describe('Tier 3: file-copy (real filesystem)', () => {
    beforeEach(() => {
      // Make both Tier 1 and Tier 2 fail
      mockExecFileSync.mockImplementation(() => {
        throw new Error('sqlite3: command not found');
      });
    });

    it('returns { method: file-copy, success: true } and copies the Cookies file', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.method).toBe('file-copy');
        expect(result.success).toBe(true);

        // The Cookies file must exist in destination
        expect(fs.existsSync(path.join(dstDir, 'Cookies'))).toBe(true);

        // Content must match source
        const srcContent = fs.readFileSync(path.join(srcDir, 'Cookies'), 'utf8');
        const dstContent = fs.readFileSync(path.join(dstDir, 'Cookies'), 'utf8');
        expect(dstContent).toBe(srcContent);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('does NOT copy WAL, SHM, or journal files to destination', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      // Add WAL/SHM/journal files to source (as Chrome might have)
      fs.writeFileSync(path.join(srcDir, 'Cookies-wal'), 'wal-data');
      fs.writeFileSync(path.join(srcDir, 'Cookies-shm'), 'shm-data');
      fs.writeFileSync(path.join(srcDir, 'Cookies-journal'), 'journal-data');

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.method).toBe('file-copy');
        expect(result.success).toBe(true);

        // WAL/SHM/journal must NOT be present in destination
        expect(fs.existsSync(path.join(dstDir, 'Cookies-wal'))).toBe(false);
        expect(fs.existsSync(path.join(dstDir, 'Cookies-shm'))).toBe(false);
        expect(fs.existsSync(path.join(dstDir, 'Cookies-journal'))).toBe(false);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('includes a warning string mentioning non-atomic copy', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.warning).toBeTruthy();
        expect(result.warning).toMatch(/non-atomic/i);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('logs a console.error warning when falling back to file-copy', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      try {
        copyCookiesAtomic(srcDir, dstDir);

        expect(consoleErrorSpy).toHaveBeenCalled();
        const logged = consoleErrorSpy.mock.calls
          .map((args: unknown[]) => args.join(' '))
          .join('\n');
        expect(logged).toMatch(/[Ww]arning/);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. All tiers fail → method: none
  // -------------------------------------------------------------------------

  describe('all tiers fail', () => {
    it('returns { method: none, success: false } with a warning when everything fails', () => {
      const srcDir = makeTmpWithCookies();
      // Destination inside a non-existent directory so copyFileSync also fails
      const dstDir = path.join(os.tmpdir(), `oc-test-nonexistent-${Date.now()}`, 'Default');

      mockExecFileSync.mockImplementation(() => {
        throw new Error('sqlite3: command not found');
      });

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.method).toBe('none');
        expect(result.success).toBe(false);
        expect(result.warning).toBeTruthy();
        expect(result.warning).toMatch(/failed/i);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
      }
    });

    it('logs a console.error when all methods fail', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = path.join(os.tmpdir(), `oc-test-nonexistent-${Date.now()}`, 'Default');

      mockExecFileSync.mockImplementation(() => {
        throw new Error('sqlite3: command not found');
      });

      try {
        copyCookiesAtomic(srcDir, dstDir);

        expect(consoleErrorSpy).toHaveBeenCalled();
        const logged = consoleErrorSpy.mock.calls
          .map((args: unknown[]) => args.join(' '))
          .join('\n');
        expect(logged).toMatch(/[Ee]rror/);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. Path safety — single quotes in path
  // -------------------------------------------------------------------------

  describe('path safety', () => {
    it('handles paths with single quotes without crashing (tier 2)', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      mockExecFileSync.mockReturnValue(Buffer.from(''));

      try {
        // Create a destination with a single-quote in the name
        const quotedDst = path.join(dstDir, "user's-profile");
        fs.mkdirSync(quotedDst, { recursive: true });

        const result = copyCookiesAtomic(srcDir, quotedDst);

        expect(result).toBeDefined();
        expect(typeof result.success).toBe('boolean');
        expect(['better-sqlite3', 'sqlite3-cli', 'file-copy', 'none']).toContain(result.method);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('attemptBetterSqlite3Copy is called with correct source and dest paths', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();

      betterSqliteSpy.mockImplementation(() => { /* success */ });

      try {
        copyCookiesAtomic(srcDir, dstDir);

        expect(betterSqliteSpy).toHaveBeenCalledWith(
          path.join(srcDir, 'Cookies'),
          path.join(dstDir, 'Cookies'),
        );
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. Return type shape validation
  // -------------------------------------------------------------------------

  describe('return type shape', () => {
    it('always returns an object with method and success fields', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result).toHaveProperty('method');
        expect(result).toHaveProperty('success');
        expect(typeof result.method).toBe('string');
        expect(typeof result.success).toBe('boolean');
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });

    it('warning is undefined when success and no fallback needed', () => {
      const srcDir = makeTmpWithCookies();
      const dstDir = makeTmpDest();
      // Tier 2 succeeds cleanly
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      try {
        const result = copyCookiesAtomic(srcDir, dstDir);

        expect(result.success).toBe(true);
        expect(result.warning).toBeUndefined();
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    });
  });
});
