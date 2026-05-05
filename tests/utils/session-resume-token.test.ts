import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  writeResumeToken,
  readResumeToken,
  deleteResumeToken,
  hasActiveResumeTokenForCurrentProcess,
  shouldKillChromeOnExit,
  killOnExitMode,
  reapExpiredTokens,
  tokenPathFor,
} from '../../src/utils/session-resume-token';

describe('session-resume-token (#661 Phase 7)', () => {
  const stateDir = path.join(os.homedir(), '.openchrome', 'state');
  const previousEnv = { ...process.env };

  function cleanupOurToken() {
    try { fs.unlinkSync(tokenPathFor(process.pid)); } catch { /* ignore */ }
  }

  beforeEach(() => {
    cleanupOurToken();
    delete process.env.OPENCHROME_KILL_ON_EXIT;
    delete process.env.OPENCHROME_SESSION_RESUME_TTL_MIN;
  });

  afterAll(() => {
    cleanupOurToken();
    process.env = previousEnv;
  });

  it('round-trips via write → read → delete', () => {
    const tok = writeResumeToken({ chromePid: 42, port: 9222 });
    expect(tok.chromePid).toBe(42);
    expect(tok.port).toBe(9222);
    expect(tok.mcpPid).toBe(process.pid);
    expect(tok.ttlEpochMs).toBeGreaterThan(Date.now());

    const read = readResumeToken(process.pid);
    expect(read).not.toBeNull();
    expect(read!.chromePid).toBe(42);

    deleteResumeToken(process.pid);
    expect(readResumeToken(process.pid)).toBeNull();
  });

  it('hasActiveResumeTokenForCurrentProcess respects TTL', () => {
    expect(hasActiveResumeTokenForCurrentProcess()).toBe(false);
    writeResumeToken({ chromePid: 1, port: 9222, ttlMs: 60_000 });
    expect(hasActiveResumeTokenForCurrentProcess()).toBe(true);

    // Manually expire by writing a past ttl
    fs.writeFileSync(tokenPathFor(process.pid), JSON.stringify({
      mcpPid: process.pid, chromePid: 1, port: 9222,
      ttlEpochMs: Date.now() - 1, createdAt: new Date().toISOString(),
    }));
    expect(hasActiveResumeTokenForCurrentProcess()).toBe(false);
    cleanupOurToken();
  });

  it('killOnExitMode parses env var', () => {
    process.env.OPENCHROME_KILL_ON_EXIT = 'always';
    expect(killOnExitMode()).toBe('always');
    process.env.OPENCHROME_KILL_ON_EXIT = 'never';
    expect(killOnExitMode()).toBe('never');
    process.env.OPENCHROME_KILL_ON_EXIT = 'auto';
    expect(killOnExitMode()).toBe('auto');
    process.env.OPENCHROME_KILL_ON_EXIT = 'invalid';
    expect(killOnExitMode()).toBe('auto');
    delete process.env.OPENCHROME_KILL_ON_EXIT;
    expect(killOnExitMode()).toBe('auto');
  });

  it('shouldKillChromeOnExit honors env var precedence', () => {
    // Default (auto) with no token → kill
    cleanupOurToken();
    expect(shouldKillChromeOnExit()).toBe(true);

    // auto with token → do not kill
    writeResumeToken({ chromePid: 1, port: 9222, ttlMs: 60_000 });
    expect(shouldKillChromeOnExit()).toBe(false);

    // always overrides token
    process.env.OPENCHROME_KILL_ON_EXIT = 'always';
    expect(shouldKillChromeOnExit()).toBe(true);

    // never overrides everything
    process.env.OPENCHROME_KILL_ON_EXIT = 'never';
    cleanupOurToken();
    expect(shouldKillChromeOnExit()).toBe(false);
  });

  it('reapExpiredTokens removes only expired files', () => {
    // Make a fresh token
    writeResumeToken({ chromePid: 1, port: 9222, ttlMs: 60_000 });

    // Make an expired one for some other (current PID + 1 likely-unused)
    fs.mkdirSync(stateDir, { recursive: true });
    const fakePid = process.pid + 100000;
    fs.writeFileSync(tokenPathFor(fakePid), JSON.stringify({
      mcpPid: fakePid, chromePid: 2, port: 9223,
      ttlEpochMs: Date.now() - 60_000, createdAt: new Date().toISOString(),
    }));

    const reaped = reapExpiredTokens();
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(readResumeToken(fakePid)).toBeNull();
    expect(readResumeToken(process.pid)).not.toBeNull(); // still valid
    cleanupOurToken();
  });
});
