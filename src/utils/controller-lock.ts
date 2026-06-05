import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getVersion } from '../version';
import { fetchJsonVersion } from '../chrome/devtools-info';

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWithinGracePeriod(startedAt: string, now: number, graceMs: number): boolean {
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
  const graceMs = options.graceMs ?? envInt('OPENCHROME_LOCK_TAKEOVER_GRACE_MS', 15_000);
  const probeAttempts = options.probeAttempts ?? envInt('OPENCHROME_LOCK_PROBE_ATTEMPTS', 3);
  const probeIntervalMs = options.probeIntervalMs ?? envInt('OPENCHROME_LOCK_PROBE_INTERVAL_MS', 500);
  const maxTakeovers = options.maxTakeovers ?? 3;
  const now = options.now ?? Date.now;
  const probe = options.probe ?? (async (port: number) => (await fetchJsonVersion(port)) !== null);
  const userDataDir = normalizeControllerUserDataDir(identity.userDataDir);
  const lockPath = getControllerLockPath(identity.port, userDataDir, rootDir);
  const selfHostname = os.hostname();

  for (let attempt = 0; attempt <= maxTakeovers; attempt++) {
    try {
      return acquireControllerLock(identity, rootDir);
    } catch (err) {
      if (!(err instanceof DuplicateControllerError)) throw err;
      if (disabled) throw err;
      const owner = err.owner;

      // Cross-host shared lock directory: never evict another machine's owner;
      // its PID/CDP are not meaningfully probeable from here.
      if (owner.hostname && owner.hostname !== selfHostname) throw err;

      // Owner may still be launching Chrome; its CDP endpoint is legitimately
      // not listening yet during the grace window.
      if (isWithinGracePeriod(owner.startedAt, now(), graceMs)) throw err;

      // Only a half-zombie (CDP unreachable across every attempt) is evictable.
      const healthy = await probeOwnerHealthy(owner.port, probeAttempts, probeIntervalMs, probe);
      if (healthy) throw err;

      if (!unlinkStaleLock(lockPath, owner.pid, owner.startedAt)) {
        // The lock changed underneath us (a concurrent taker won) — re-evaluate.
        continue;
      }
      // Loop: re-attempt the O_EXCL create. A concurrent taker may still win,
      // in which case the next iteration sees a (now healthy) owner and throws.
    }
  }

  // Takeover budget exhausted — surface the duplicate-owner error to the caller.
  return acquireControllerLock(identity, rootDir);
}
