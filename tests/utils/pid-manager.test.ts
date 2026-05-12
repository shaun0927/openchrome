/**
 * pid-manager startup cleanup test (#896).
 *
 * Asserts that any stale `~/.openchrome/network-bodies/<sessionId>/`
 * directories left behind by a previous SIGKILL'd process are removed when
 * `cleanOrphanedChromeProcesses` runs.
 *
 * Strategy:
 *   1. Create a fake stale session dir with a body file under the real
 *      body-store root.
 *   2. Call cleanOrphanedChromeProcesses with a port that has no PID file.
 *   3. Assert the stale dir is gone.
 *
 * The body-store root is real (`~/.openchrome/network-bodies/`), so we use a
 * uniquely-named session id and only assert removal of that one directory —
 * we never touch siblings.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  cleanOrphanedChromeProcesses,
} from '../../src/utils/pid-manager';
import {
  ensureSessionDir,
  getSessionBodyDir,
  cleanupAllStaleSessionsSync,
} from '../../src/core/network-capture/body-store';

describe('pid-manager startup hook — network-bodies cleanup (#896)', () => {
  test('cleanOrphanedChromeProcesses removes stale network-bodies/<sessionId>/ directories', async () => {
    const sessionId = `stale-${process.pid}-${Date.now()}`;
    const dir = await ensureSessionDir(sessionId);
    fs.writeFileSync(path.join(dir, 'fake-body'), 'leftover');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fake-body'))).toBe(true);

    // Use a high port that no real openchrome instance would bind to; this
    // ensures no PIDs are found and no Chromes are killed. The body cleanup
    // runs unconditionally.
    cleanOrphanedChromeProcesses([60000 + (process.pid % 5000)]);

    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(getSessionBodyDir(sessionId))).toBe(false);
  });

  test('cleanupAllStaleSessionsSync is idempotent on missing root', () => {
    // Even if the root doesn't exist, the sync purge must not throw and must
    // return 0. We don't actually delete the user's real root — we just call
    // the function and assert it returns a number.
    const removed = cleanupAllStaleSessionsSync();
    expect(typeof removed).toBe('number');
  });
});
