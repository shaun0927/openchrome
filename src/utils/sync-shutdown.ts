/**
 * Synchronous best-effort Chrome shutdown (#661 Phase 2 / Phase 3).
 *
 * Called from:
 *   - stdio.ts: when stdin EOF is observed (parent agent exited).
 *   - index.ts: as a process.on('exit') safety net for any other exit path.
 *
 * Why synchronous: process.exit() in Node bypasses async cleanup. To kill
 * Chrome reliably, we must issue the kill syscalls before returning to the
 * exit machinery.
 *
 * Safety contract:
 *   - Only kills Chrome instances we launched (launchMode==='isolated').
 *   - NEVER kills attach-mode (user-owned) Chrome.
 *   - Respects OPENCHROME_KILL_ON_EXIT (auto/always/never) and session-resume tokens.
 *
 * Best-effort: we never throw; failures are logged to stderr.
 */

import { killProcessTree } from './pid-manager';
import { removeMarker } from '../chrome/ownership-marker';
import { shouldKillChromeOnExit } from './session-resume-token';

const LOG_PREFIX = '[openchrome:sync-shutdown]';

interface ManagedChrome {
  pid: number;
  userDataDir?: string;
}

let alreadyRan = false;

/**
 * Discover Chrome PIDs that are owned by the current openchrome process.
 * Caller passes a "lookup" function rather than us importing launcher/pool
 * directly, both to avoid require-cycle headaches and to let tests
 * substitute in synthetic data.
 *
 * Falls back to the in-module registry below if no lookup is supplied.
 */
type ManagedLookup = () => ManagedChrome[];

let registry: ManagedChrome[] = [];

/**
 * Register a Chrome process so the synchronous shutdown path can find it
 * even if the module-level singletons (launcher, pool) are not retrievable
 * during late shutdown.
 */
export function registerManagedChrome(entry: ManagedChrome): void {
  if (!Number.isFinite(entry.pid) || entry.pid <= 0) return;
  // Replace any prior entry with the same PID (re-launch case).
  const idx = registry.findIndex((e) => e.pid === entry.pid);
  if (idx >= 0) registry[idx] = entry;
  else registry.push(entry);
}

export function unregisterManagedChrome(pid: number): void {
  registry = registry.filter((e) => e.pid !== pid);
}

export function listRegisteredManagedChromes(): readonly ManagedChrome[] {
  return registry.slice();
}

/**
 * Synchronous best-effort shutdown of openchrome-managed Chromes.
 * Idempotent: repeated calls are no-ops after the first.
 */
export function shutdownSyncBestEffort(opts?: { lookup?: ManagedLookup; force?: boolean }): void {
  if (alreadyRan) return;
  alreadyRan = true;

  if (!(opts?.force === true) && !shouldKillChromeOnExit()) {
    console.error(`${LOG_PREFIX} skip kill (OPENCHROME_KILL_ON_EXIT or active session-resume token)`);
    return;
  }

  let entries: ManagedChrome[];
  try {
    entries = opts?.lookup ? opts.lookup() : registry.slice();
  } catch (err) {
    console.error(`${LOG_PREFIX} lookup failed:`, err);
    entries = registry.slice();
  }

  if (entries.length === 0) return;

  for (const entry of entries) {
    try {
      killProcessTree(entry.pid, 'SIGTERM');
    } catch (err) {
      console.error(`${LOG_PREFIX} SIGTERM ${entry.pid} failed:`, err);
    }
  }

  // 200ms synchronous grace window for Chrome to start tearing down before SIGKILL.
  // We block the event loop intentionally — by design this is the very last
  // thing the process does before exit, so blocking is acceptable.
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    // Busy wait — Node has no synchronous sleep without spawning a child.
    // The wait is bounded and only runs at process exit.
  }

  for (const entry of entries) {
    try {
      killProcessTree(entry.pid, 'SIGKILL');
    } catch {
      /* already dead, ignore */
    }
    try {
      removeMarker({ chromePid: entry.pid, userDataDir: entry.userDataDir });
    } catch {
      /* best effort */
    }
  }

  console.error(`${LOG_PREFIX} synchronous shutdown completed for ${entries.length} Chrome process(es)`);
}

/** Test-only: reset module state. */
export function _resetForTesting(): void {
  alreadyRan = false;
  registry = [];
}
