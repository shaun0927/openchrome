import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOG_PREFIX = "[openchrome:pid]";

/**
 * Get the path to the PID file for a given port.
 * @param port - The port number the MCP server is listening on.
 */
export function getPidFilePath(port: number): string {
  return path.join(os.tmpdir(), `openchrome-${port}.pid`);
}

/**
 * Check whether a process with the given PID is currently running.
 * @param pid - The process ID to check.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read all PIDs from the PID file for a given port.
 * Returns an empty array if the file does not exist or cannot be read.
 * @param filePath - Absolute path to the PID file.
 */
function readPids(filePath: string): number[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => parseInt(line, 10))
      .filter((pid) => !isNaN(pid) && pid > 0);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `${LOG_PREFIX} Failed to read PID file at ${filePath}:`,
        err
      );
    }
    return [];
  }
}

/**
 * Write a list of PIDs to the PID file, overwriting any existing content.
 * Uses a write-then-rename pattern to reduce the window for partial writes.
 * @param filePath - Absolute path to the PID file.
 * @param pids - Array of PIDs to persist.
 */
function writePids(filePath: string, pids: number[]): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const content = pids.join("\n") + (pids.length > 0 ? "\n" : "");
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", flag: "w" });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(
      `${LOG_PREFIX} Failed to write PID file at ${filePath}:`,
      err
    );
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Remove stale (dead) PIDs from the PID file for the given port.
 * @param port - The port number used to locate the PID file.
 * @returns The number of stale PIDs that were removed.
 */
export function cleanStalePids(port: number): number {
  const filePath = getPidFilePath(port);
  const pids = readPids(filePath);
  if (pids.length === 0) {
    return 0;
  }

  const alivePids = pids.filter((pid) => isPidAlive(pid));
  const removedCount = pids.length - alivePids.length;

  if (removedCount > 0) {
    console.error(
      `${LOG_PREFIX} Cleaning ${removedCount} stale PID(s) from ${filePath}`
    );
    writePids(filePath, alivePids);
  }

  return removedCount;
}

/**
 * Append the current process PID to the PID file for the given port,
 * after cleaning any stale PIDs. Registers a process 'exit' handler so
 * the PID is automatically removed on normal exit.
 * @param port - The port number the MCP server is listening on.
 */
export function writePidFile(port: number): void {
  const filePath = getPidFilePath(port);

  cleanStalePids(port);

  const pids = readPids(filePath);
  if (!pids.includes(process.pid)) {
    pids.push(process.pid);
    writePids(filePath, pids);
    console.error(
      `${LOG_PREFIX} Registered PID ${process.pid} in ${filePath}`
    );
  }

  process.once("exit", () => {
    removePidFile(port);
  });
}

/**
 * Remove the current process PID from the PID file for the given port.
 * If the file becomes empty after removal, it is deleted.
 * @param port - The port number used to locate the PID file.
 */
export function removePidFile(port: number): void {
  const filePath = getPidFilePath(port);
  const pids = readPids(filePath);
  const remaining = pids.filter((pid) => pid !== process.pid);

  if (remaining.length === 0) {
    try {
      fs.unlinkSync(filePath);
      console.error(
        `${LOG_PREFIX} Removed PID file ${filePath} (no active PIDs remain)`
      );
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(
          `${LOG_PREFIX} Failed to delete PID file at ${filePath}:`,
          err
        );
      }
    }
  } else {
    writePids(filePath, remaining);
    console.error(
      `${LOG_PREFIX} Deregistered PID ${process.pid} from ${filePath}`
    );
  }
}

/**
 * List all PIDs in the PID file for the given port that are still running.
 * @param port - The port number used to locate the PID file.
 * @returns An array of active process IDs.
 */
export function listActivePids(port: number): number[] {
  const filePath = getPidFilePath(port);
  const pids = readPids(filePath);
  return pids.filter((pid) => isPidAlive(pid));
}
