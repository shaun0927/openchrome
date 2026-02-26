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
  } catch {
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
