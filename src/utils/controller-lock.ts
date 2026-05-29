import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getVersion } from '../version';

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
