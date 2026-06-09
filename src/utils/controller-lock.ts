import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getVersion } from '../version';
import { fetchJsonVersion } from '../chrome/devtools-info';
import { DEFAULT_CHROME_LAUNCH_TIMEOUT_MS } from '../config/defaults';

export interface ControllerLockIdentity {
  port: number;
  userDataDir: string;
  transportMode?: string;
  lifecycleMode?: string;
  cwd?: string;
  command?: string[];
  now?: () => number;
  pid?: number;
}

export interface ControllerLockMetadata {
  pid: number;
  command: string[];
  version: string;
  cwd: string;
  port: number;
  userDataDir: string;
  startedAt: string;
  /**
   * Last time the owner confirmed its Chrome/CDP was reachable and refreshed
   * the lock. Distinguishes a live owner whose Chrome is briefly down (e.g.
   * mid-relaunch after a crash) from a half-zombie whose Chrome is gone for
   * good: a contender only takes over when this is stale beyond the grace.
   * Falls back to `startedAt` for locks written before this field existed.
   */
  lastHeartbeatAt: string;
  lifecycleMode?: string;
  transportMode?: string;
  hostname: string;
}

export interface ControllerLockHandle {
  key: string;
  path: string;
  metadata: ControllerLockMetadata;
  release(): void;
}

export class DuplicateControllerError extends Error {
  readonly lockPath: string;
  readonly owner: ControllerLockMetadata;

  constructor(lockPath: string, owner: ControllerLockMetadata) {
    super(
      `Another OpenChrome controller is already registered for Chrome port ${owner.port} ` +
        `and profile ${owner.userDataDir} (pid ${owner.pid}).`,
    );
    this.name = 'DuplicateControllerError';
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export function normalizeControllerUserDataDir(userDataDir: string): string {
  return path.resolve(userDataDir);
}

export function controllerLockKey(port: number, userDataDir: string): string {
  const normalized = normalizeControllerUserDataDir(userDataDir);
  const slug = normalized
    .replace(/^[a-zA-Z]:/, (drive) => drive.toLowerCase())
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'profile';
  return `port-${port}-${slug}`;
}

export function getControllerLockPath(port: number, userDataDir: string, rootDir?: string): string {
  const root = rootDir || process.env.OPENCHROME_CONTROLLER_LOCK_DIR || path.join(os.homedir(), '.openchrome', 'locks');
  return path.join(root, `${controllerLockKey(port, userDataDir)}.json`);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function readMetadata(lockPath: string): ControllerLockMetadata | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<ControllerLockMetadata>;
    const pid = parsed.pid;
    const port = parsed.port;
    const userDataDir = parsed.userDataDir;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || typeof userDataDir !== 'string' || typeof port !== 'number') {
      return null;
    }
    return {
      pid,
      command: Array.isArray(parsed.command) ? parsed.command.map(String) : [],
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      port,
      userDataDir,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      lastHeartbeatAt:
        typeof parsed.lastHeartbeatAt === 'string'
          ? parsed.lastHeartbeatAt
          : (typeof parsed.startedAt === 'string' ? parsed.startedAt : ''),
      ...(typeof parsed.lifecycleMode === 'string' ? { lifecycleMode: parsed.lifecycleMode } : {}),
      ...(typeof parsed.transportMode === 'string' ? { transportMode: parsed.transportMode } : {}),
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
    };
  } catch {
    return null;
  }
}

function buildMetadata(identity: ControllerLockIdentity): ControllerLockMetadata {
  return {
    pid: identity.pid ?? process.pid,
    command: identity.command ?? process.argv,
    version: getVersion(),
    cwd: identity.cwd ?? process.cwd(),
    port: identity.port,
    userDataDir: normalizeControllerUserDataDir(identity.userDataDir),
    startedAt: new Date((identity.now ?? Date.now)()).toISOString(),
    lastHeartbeatAt: new Date((identity.now ?? Date.now)()).toISOString(),
    ...(identity.lifecycleMode ? { lifecycleMode: identity.lifecycleMode } : {}),
    ...(identity.transportMode ? { transportMode: identity.transportMode } : {}),
    hostname: os.hostname(),
  };
}

export function acquireControllerLock(identity: ControllerLockIdentity, rootDir?: string): ControllerLockHandle {
  const userDataDir = normalizeControllerUserDataDir(identity.userDataDir);
  const lockPath = getControllerLockPath(identity.port, userDataDir, rootDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const metadata = buildMetadata({ ...identity, userDataDir });
  const serialized = JSON.stringify(metadata, null, 2) + '\n';

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, serialized);
      } finally {
        fs.closeSync(fd);
      }
      return {
        key: controllerLockKey(identity.port, userDataDir),
        path: lockPath,
        metadata,
        release: () => releaseControllerLock(lockPath, metadata.pid),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      const existing = readMetadata(lockPath);
      if (existing && isPidAlive(existing.pid)) {
        throw new DuplicateControllerError(lockPath, existing);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr) {
        const unlinkCode = (unlinkErr as NodeJS.ErrnoException).code;
        if (unlinkCode !== 'ENOENT') throw unlinkErr;
      }
      // Retry after removing stale or malformed lock.
    }
  }
}

export function releaseControllerLock(lockPath: string, pid: number = process.pid): void {
  const existing = readMetadata(lockPath);
  if (existing && existing.pid !== pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function formatDuplicateControllerMessage(error: DuplicateControllerError): string {
  const owner = error.owner;
  const command = owner.command.length > 0 ? owner.command.join(' ') : '<unknown command>';
  return [
    `[openchrome] Refusing to start a second direct controller for Chrome port ${owner.port} and profile:`,
    `  ${owner.userDataDir}`,
    '',
    `Existing owner: pid=${owner.pid}, version=${owner.version}, cwd=${owner.cwd || '<unknown>'}`,
    `Command: ${command}`,
    `Lock: ${error.lockPath}`,
    '',
    'Multiple independent openchrome-mcp processes controlling the same Chrome/profile can race over',
    'CDP target lifecycle, cleanup, reconnect, and tab ownership, causing stale targets or MCP disconnects.',
    '',
    'Safe options:',
    '  - stop the existing OpenChrome MCP owner before starting this one;',
    '  - choose a different --port and --user-data-dir for this client;',
    '  - use the future broker/shared-owner topology when available.',
    '',
    'For debugging only, set OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH=1 or pass',
    '--allow-unsafe-shared-attach to bypass this guard.',
  ].join('\n');
}

/**
 * Tunables for health-aware controller-lock acquisition. Each has an env
 * override so operators can adjust grace/probe behaviour without a rebuild;
 * tests inject `probe`/`now` to stay hermetic.
 */
export interface HealthAwareAcquireOptions {
  /**
   * Do not evict an owner whose process started less than `graceMs` ago — its
   * Chrome may still be booting and its CDP endpoint not yet listening.
   */
  graceMs?: number;
  /** Total CDP probe attempts before declaring the owner a half-zombie. */
  probeAttempts?: number;
  /** Delay between probe attempts. */
  probeIntervalMs?: number;
  /** Maximum stale-lock takeovers before giving up and surfacing the error. */
  maxTakeovers?: number;
  /** Injectable reachability probe (tests). Resolves true when CDP responds. */
  probe?: (port: number) => Promise<boolean>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Disable health-based takeover entirely (env escape hatch). */
  disabled?: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Extra headroom added on top of the Chrome launch budget when deriving the
 * default takeover grace. `startedAt` is stamped at lock-ACQUIRE time (MCP
 * boot), which precedes the Chrome launch — so this buffer must also absorb a
 * slow MCP boot (profile scan, cookie copy, disk latency) before Chrome even
 * starts, on top of the launch budget itself.
 */
const LOCK_TAKEOVER_GRACE_BUFFER_MS = 60_000;

/**
 * Resolve the Chrome launch budget the owner is allowed before its CDP
 * endpoint must be listening — the same value the launcher uses
 * (CHROME_LAUNCH_TIMEOUT_MS, else DEFAULT_CHROME_LAUNCH_TIMEOUT_MS).
 */
function resolveChromeLaunchBudgetMs(): number {
  const raw = Number.parseInt(process.env.CHROME_LAUNCH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHROME_LAUNCH_TIMEOUT_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWithinGracePeriod(startedAt: string, now: number, graceMs: number): boolean {
  // A legacy lock written before `startedAt` existed has an empty string here:
  // no timestamp means no grace can be computed, so proceed straight to the CDP
  // probe (the probe — not the clock — then decides whether to evict).
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return false;
  return now - started < graceMs;
}

async function probeOwnerHealthy(
  port: number,
  attempts: number,
  intervalMs: number,
  probe: (port: number) => Promise<boolean>,
): Promise<boolean> {
  const total = Math.max(1, attempts);
  for (let i = 0; i < total; i++) {
    if (await probe(port)) return true;
    if (i < total - 1) await delay(intervalMs);
  }
  return false;
}

/**
 * Remove the lock file only if it still describes the exact owner we just
 * judged stale (same pid + startedAt). Combined with the O_EXCL re-acquire in
 * the caller, this makes takeover safe under concurrency: a racing taker that
 * already rewrote the lock fails the match and we re-evaluate instead of
 * clobbering the new (possibly healthy) owner.
 */
function unlinkStaleLock(lockPath: string, pid: number, startedAt: string): boolean {
  const current = readMetadata(lockPath);
  if (!current) return true; // already gone or malformed — let acquire race decide
  if (current.pid !== pid || current.startedAt !== startedAt) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

/**
 * Health-aware wrapper around {@link acquireControllerLock}.
 *
 * The synchronous lock recovers only *dead-pid* stale locks. A "half-zombie"
 * owner — MCP process alive but its managed Chrome/CDP gone — keeps PID
 * liveness true and would otherwise hold the lock forever, deadlocking every
 * other session (#1474). This wrapper additionally probes the owner's CDP
 * endpoint and, when it is unreachable past a grace window, takes the lock
 * over. A genuinely healthy owner is never evicted.
 *
 * Guardrails: a boot grace period (`startedAt`), multi-attempt probing to
 * tolerate transient stalls, a hostname check so a shared lock directory across
 * machines is never raced cross-host, an atomic compare-and-unlink takeover,
 * and an env kill-switch (`OPENCHROME_LOCK_HEALTH_TAKEOVER=0`).
 */
export async function acquireControllerLockWithHealthCheck(
  identity: ControllerLockIdentity,
  rootDir?: string,
  options: HealthAwareAcquireOptions = {},
): Promise<ControllerLockHandle> {
  const disabled = options.disabled ?? process.env.OPENCHROME_LOCK_HEALTH_TAKEOVER === '0';
  // The lock is acquired BEFORE ensureChrome() launches Chrome, so a
  // legitimately-launching owner has no CDP endpoint for up to the full launch
  // budget (default 60s). The grace must exceed that budget, or a second
  // --auto-launch started mid-launch would probe an empty port and evict the
  // live owner — turning a slow-but-valid startup into split ownership (#1474).
  // NOTE: `OPENCHROME_LOCK_TAKEOVER_GRACE_MS=0` disables the grace window (a
  // foot-gun). To turn off health-based takeover entirely, use the dedicated
  // kill-switch `OPENCHROME_LOCK_HEALTH_TAKEOVER=0` instead.
  const graceMs = options.graceMs
    ?? envInt('OPENCHROME_LOCK_TAKEOVER_GRACE_MS', resolveChromeLaunchBudgetMs() + LOCK_TAKEOVER_GRACE_BUFFER_MS);
  const probeAttempts = options.probeAttempts ?? envInt('OPENCHROME_LOCK_PROBE_ATTEMPTS', 3);
  const probeIntervalMs = options.probeIntervalMs ?? envInt('OPENCHROME_LOCK_PROBE_INTERVAL_MS', 500);
  const maxTakeovers = options.maxTakeovers ?? envInt('OPENCHROME_LOCK_MAX_TAKEOVERS', 3);
  const now = options.now ?? Date.now;
  const probe = options.probe ?? (async (port: number) => (await fetchJsonVersion(port)) !== null);
  const userDataDir = normalizeControllerUserDataDir(identity.userDataDir);
  const lockPath = getControllerLockPath(identity.port, userDataDir, rootDir);
  const selfHostname = os.hostname();

  // Bound total iterations independently of the takeover budget so pathological
  // lock churn (a concurrent taker repeatedly rewriting the lock) can never
  // livelock. Only *successful* takeovers count against maxTakeovers, so a
  // contended re-evaluation no longer burns the budget prematurely.
  const maxIterations = maxTakeovers + 8;
  let takeovers = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    try {
      return acquireControllerLock(identity, rootDir);
    } catch (err) {
      if (!(err instanceof DuplicateControllerError)) throw err;
      if (disabled) throw err;
      const owner = err.owner;

      // Cross-host shared lock directory: never evict another machine's owner;
      // its PID/CDP are not meaningfully probeable from here.
      if (owner.hostname && owner.hostname !== selfHostname) throw err;

      // Owner liveness: a live owner refreshes `lastHeartbeatAt` whenever its
      // Chrome/CDP is reachable. If that is recent (within grace), the owner is
      // either still launching Chrome or mid-relaunch after a crash — its CDP
      // is legitimately down for now, so do not evict. Only a heartbeat stale
      // beyond the grace marks a true half-zombie. (Falls back to startedAt for
      // pre-heartbeat locks.)
      const ownerLivenessAt = owner.lastHeartbeatAt || owner.startedAt;
      if (isWithinGracePeriod(ownerLivenessAt, now(), graceMs)) throw err;

      // Only a half-zombie (CDP unreachable across every attempt) is evictable.
      const healthy = await probeOwnerHealthy(owner.port, probeAttempts, probeIntervalMs, probe);
      if (healthy) throw err;

      // Out of takeover budget — surface the duplicate-owner error rather than
      // evicting yet another owner.
      if (takeovers >= maxTakeovers) throw err;

      if (unlinkStaleLock(lockPath, owner.pid, owner.startedAt)) {
        // A real takeover: count it, then re-attempt the O_EXCL create.
        takeovers += 1;
      }
      // else: the lock changed underneath us (a concurrent taker won). Re-
      // evaluate WITHOUT spending takeover budget — the next iteration probes
      // the new owner and throws if it is healthy.
    }
  }

  // Iteration ceiling hit under pathological churn — surface the duplicate error.
  return acquireControllerLock(identity, rootDir);
}

/**
 * Refresh the owner's `lastHeartbeatAt` in the lock file. Best-effort and
 * pid-guarded: if the lock has been taken over (pid changed) or removed, this
 * is a no-op, so a stale owner can never resurrect a lock it no longer holds.
 */
export function recordControllerHeartbeat(
  lockPath: string,
  pid: number,
  nowFn: () => number = Date.now,
): void {
  let fd: number | null = null;
  try {
    // Open the currently-linked lock file and update that same inode. A simple
    // readMetadata(path) -> writeFile(path) sequence can resurrect stale
    // ownership if another process unlinks/recreates the lock between the read
    // and write. With an already-open fd, a concurrent takeover that unlinks the
    // old file makes our write target the unlinked old inode, never the new
    // owner's path.
    fd = fs.openSync(lockPath, 'r+');
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as Partial<ControllerLockMetadata>;
    const currentPid = parsed.pid;
    const port = parsed.port;
    const userDataDir = parsed.userDataDir;
    if (
      currentPid !== pid ||
      typeof port !== 'number' ||
      !Number.isSafeInteger(port) ||
      typeof userDataDir !== 'string'
    ) return;
    const updated: ControllerLockMetadata = {
      pid,
      command: Array.isArray(parsed.command) ? parsed.command.map(String) : [],
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      port,
      userDataDir,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      lastHeartbeatAt: new Date(nowFn()).toISOString(),
      ...(typeof parsed.lifecycleMode === 'string' ? { lifecycleMode: parsed.lifecycleMode } : {}),
      ...(typeof parsed.transportMode === 'string' ? { transportMode: parsed.transportMode } : {}),
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
    };
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify(updated, null, 2) + '\n', 0, 'utf8');
  } catch {
    /* best-effort */
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

export interface ControllerHeartbeatHandle {
  stop(): void;
}

/**
 * Periodically probe the owner's own Chrome/CDP and, when reachable, refresh
 * the lock heartbeat so contenders can tell a live owner — even one briefly
 * relaunching Chrome after a crash — from a half-zombie whose Chrome is gone
 * for good. The timer is unref'd so it never keeps the process alive; disable
 * with OPENCHROME_LOCK_HEARTBEAT=0.
 */
export function startControllerHeartbeat(
  handle: Pick<ControllerLockHandle, 'path' | 'metadata'>,
  probe: () => Promise<boolean>,
  options: { intervalMs?: number; nowFn?: () => number } = {},
): ControllerHeartbeatHandle {
  if (process.env.OPENCHROME_LOCK_HEARTBEAT === '0') {
    return { stop: () => undefined };
  }
  const intervalMs = Math.max(1000, options.intervalMs ?? envInt('OPENCHROME_LOCK_HEARTBEAT_INTERVAL_MS', 10_000));
  const nowFn = options.nowFn ?? Date.now;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        if (await probe()) recordControllerHeartbeat(handle.path, handle.metadata.pid, nowFn);
      } catch {
        // A failed/throwing probe simply means no refresh this tick.
      } finally {
        inFlight = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
