/**
 * Overflow sessions — give a second (third, ...) MCP host its own Chrome.
 *
 * When the default port/profile is already owned by another live OpenChrome
 * controller, `--on-busy new-port` claims the next free port instead of
 * attaching to (or failing against) the owner. Each slot uses a stable
 * user-data-dir (`~/.openchrome/profile-overflow-<port>`) seeded with the
 * default profile's cookies, so logins carry over. The claiming process owns
 * that Chrome like any auto-launched one: it is killed when the host session
 * (stdin) ends, and orphan reaping covers hard kills.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireControllerLock,
  ControllerLockHandle,
  DuplicateControllerError,
} from './controller-lock';
import { checkDebugPort } from './launcher-debug-port';
import { ProfileManager } from './profile-manager';

export type OnBusyMode = 'broker' | 'new-port';

export const DEFAULT_OVERFLOW_SLOTS = 8;

export function resolveOnBusyMode(cliValue: string | undefined, env: NodeJS.ProcessEnv = process.env): OnBusyMode | undefined {
  const raw = (cliValue ?? env.OPENCHROME_ON_BUSY ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'broker' || raw === 'new-port') return raw;
  throw new Error(`Unknown --on-busy mode "${raw}". Expected "broker" or "new-port".`);
}

export function overflowUserDataDir(port: number): string {
  return path.join(os.homedir(), '.openchrome', `profile-overflow-${port}`);
}

export interface OverflowSlot {
  port: number;
  userDataDir: string;
  lock: ControllerLockHandle;
}

/**
 * Claim the first port after `basePort` that has no Chrome listening and no
 * live controller lock. Returns null when every slot is taken.
 */
export async function claimOverflowSlot(options: {
  basePort: number;
  lifecycleMode?: string;
  transportMode?: string;
  maxSlots?: number;
}): Promise<OverflowSlot | null> {
  const maxSlots = options.maxSlots ?? DEFAULT_OVERFLOW_SLOTS;
  for (let offset = 1; offset <= maxSlots; offset++) {
    const port = options.basePort + offset;
    const userDataDir = overflowUserDataDir(port);
    let lock: ControllerLockHandle;
    try {
      lock = acquireControllerLock({
        port,
        userDataDir,
        lifecycleMode: options.lifecycleMode,
        transportMode: options.transportMode,
      });
    } catch (err) {
      if (err instanceof DuplicateControllerError) continue;
      throw err;
    }
    // A Chrome we do not own (manual launch, another tool) may hold the port.
    if (await checkDebugPort(port, 500)) {
      lock.release();
      continue;
    }
    return { port, userDataDir, lock };
  }
  return null;
}

/**
 * Copy cookies/storage from the default persistent profile into the overflow
 * profile so the extra Chrome starts signed in. Best-effort and non-fatal.
 */
export function seedOverflowProfile(userDataDir: string, sourceDir: string = ProfileManager.PERSISTENT_PROFILE_DIR): void {
  if (!fs.existsSync(path.join(sourceDir, 'Default'))) return;
  new ProfileManager().syncProfileData(sourceDir, userDataDir, 'Default', { updateMetadata: false });
}
