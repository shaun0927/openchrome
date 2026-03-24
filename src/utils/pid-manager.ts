import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOG_PREFIX = "[openchrome:pid]";

export function getPidFilePath(port: number): string {
  return path.join(os.tmpdir(), `openchrome-${port}.pid`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we lack permission to signal it (common on Windows)
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function readPids(filePath: string): number[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").map(l => l.trim()).filter(l => l.length > 0).map(l => parseInt(l, 10)).filter(p => !isNaN(p) && p > 0);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`${LOG_PREFIX} Failed to read PID file at ${filePath}:`, err);
    }
    return [];
  }
}

function writePids(filePath: string, pids: number[]): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const content = pids.join("\n") + (pids.length > 0 ? "\n" : "");
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", flag: "w" });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to write PID file at ${filePath}:`, err);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

export function cleanStalePids(port: number): number {
  const filePath = getPidFilePath(port);
  const pids = readPids(filePath);
  if (pids.length === 0) return 0;
  const alivePids = pids.filter(pid => isPidAlive(pid));
  const removedCount = pids.length - alivePids.length;
  if (removedCount > 0) {
    console.error(`${LOG_PREFIX} Cleaning ${removedCount} stale PID(s) from ${filePath}`);
    writePids(filePath, alivePids);
  }
  return removedCount;
}

export function writePidFile(port: number): void {
  const filePath = getPidFilePath(port);
  cleanStalePids(port);
  const pids = readPids(filePath);
  if (!pids.includes(process.pid)) {
    pids.push(process.pid);
    writePids(filePath, pids);
    console.error(`${LOG_PREFIX} Registered PID ${process.pid} in ${filePath}`);
  }
  process.once("exit", () => { removePidFile(port); });
}

export function removePidFile(port: number): void {
  const filePath = getPidFilePath(port);
  const pids = readPids(filePath);
  const remaining = pids.filter(pid => pid !== process.pid);
  if (remaining.length === 0) {
    try {
      fs.unlinkSync(filePath);
      console.error(`${LOG_PREFIX} Removed PID file ${filePath} (no active PIDs remain)`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`${LOG_PREFIX} Failed to delete PID file at ${filePath}:`, err);
      }
    }
  } else {
    writePids(filePath, remaining);
    console.error(`${LOG_PREFIX} Deregistered PID ${process.pid} from ${filePath}`);
  }
}

export function listActivePids(port: number): number[] {
  const filePath = getPidFilePath(port);
  return readPids(filePath).filter(pid => isPidAlive(pid));
}

// ─── Chrome PID file tracking (zombie prevention) ──────────────────────────

/**
 * Chrome PID file path: /tmp/openchrome-chrome-{port}.pid
 * Separate from the MCP server PID file to track Chrome processes independently.
 */
export function getChromePidFilePath(port: number): string {
  return path.join(os.tmpdir(), `openchrome-chrome-${port}.pid`);
}

/**
 * Write Chrome PID to file (called after successful Chrome spawn).
 * Uses atomic rename to prevent partial reads.
 */
export function writeChromePid(port: number, chromePid: number): void {
  const filePath = getChromePidFilePath(port);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, String(chromePid) + '\n', { encoding: 'utf8', flag: 'w' });
    fs.renameSync(tmpPath, filePath);
    console.error(`${LOG_PREFIX} Registered Chrome PID ${chromePid} for port ${port}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to write Chrome PID file:`, err);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Remove Chrome PID file (called after Chrome process is killed).
 */
export function removeChromePid(port: number): void {
  const filePath = getChromePidFilePath(port);
  try {
    fs.unlinkSync(filePath);
    console.error(`${LOG_PREFIX} Removed Chrome PID file for port ${port}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${LOG_PREFIX} Failed to remove Chrome PID file:`, err);
    }
  }
}

/**
 * Read Chrome PID from file.
 * Returns null if file doesn't exist or content is invalid.
 */
export function readChromePid(port: number): number | null {
  const filePath = getChromePidFilePath(port);
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Kill orphaned Chrome processes from previous crashed sessions.
 * An orphan is a Chrome process whose PID file exists AND is alive,
 * but no MCP server process is managing it.
 * Returns count of orphans killed.
 */
export function cleanOrphanedChromeProcesses(basePorts: number[]): number {
  let killed = 0;
  for (const port of basePorts) {
    const chromePid = readChromePid(port);
    if (chromePid === null) continue;

    // Check if this Chrome process is still alive
    if (!isPidAlive(chromePid)) {
      // PID file is stale — Chrome already died
      removeChromePid(port);
      continue;
    }

    // Check if there's an MCP server process managing this Chrome
    const serverPids = listActivePids(port);
    if (serverPids.length > 0) {
      // An MCP server is still alive and presumably managing this Chrome
      continue;
    }

    // Orphan detected: Chrome is alive but no MCP server is managing it
    console.error(`${LOG_PREFIX} Killing orphaned Chrome process (PID ${chromePid}) on port ${port}`);
    try {
      process.kill(chromePid, 'SIGTERM');
      killed++;
    } catch {
      // Process may have died between check and kill
    }
    removeChromePid(port);
  }
  return killed;
}
