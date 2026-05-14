import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listMarkers, deleteMarkerFile, verifyChromePidIdentity, OwnershipMarker } from "../chrome/ownership-marker";
import { listAllTokens } from "./session-resume-token";
import { getLifecycleBus } from "../core/lifecycle";
import { cleanupAllStaleSessionsSync as cleanupNetworkBodiesSync } from "../core/network-capture/body-store";

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

export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      require('child_process').execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
    } catch {
      try { process.kill(pid, signal); } catch { /* ignore */ }
    }
    return;
  }
  try { process.kill(-pid, signal); } catch { /* ignore */ }
  try { process.kill(pid, signal); } catch { /* ignore */ }
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


export interface OrphanChromePreview {
  count: number;
  samples: Array<{ pid: number; source: 'pid-file' | 'marker'; port?: number; marker?: string; userDataDir?: string }>;
  details: {
    checkedPorts: number[];
    pidFileCandidates: number;
    markerCandidates: number;
  };
}

export function previewOrphanedChromeProcesses(basePorts: number[]): OrphanChromePreview {
  const samples: OrphanChromePreview['samples'] = [];
  let pidFileCandidates = 0;
  for (const port of basePorts) {
    const chromePid = readChromePid(port);
    if (chromePid === null) continue;
    if (!isPidAlive(chromePid)) continue;
    const serverPids = listActivePids(port);
    if (serverPids.length > 0) continue;
    pidFileCandidates++;
    if (samples.length < 10) samples.push({ pid: chromePid, source: 'pid-file', port });
  }

  let markerCandidates = 0;
  for (const { marker } of listMarkers()) {
    if (classifyMarker(marker) !== 'kill') continue;
    markerCandidates++;
    if (samples.length < 10) {
      samples.push({
        pid: marker.pid,
        source: 'marker',
        marker: marker.marker,
        userDataDir: marker.userDataDir,
      });
    }
  }

  return {
    count: pidFileCandidates + markerCandidates,
    samples,
    details: {
      checkedPorts: basePorts,
      pidFileCandidates,
      markerCandidates,
    },
  };
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
      killProcessTree(chromePid, 'SIGTERM');
      killed++;
      // #857: announce the orphan-reap exit on the lifecycle bus so
      // recorder/journal consumers can see this is an automated cleanup
      // distinct from a user-driven close or crash. emit() is no-throw.
      try {
        getLifecycleBus().emit({
          kind: 'chrome:exit',
          pid: chromePid,
          reason: 'orphan-reap',
          ts: Date.now(),
        });
      } catch {
        /* bus is no-throw; defence in depth */
      }
    } catch {
      // Process may have died between check and kill
    }
    removeChromePid(port);
  }

  // Also walk ownership markers (#661 Phase 5) to catch Chromes that bound to
  // a port we don't know about, or whose PID file was lost.
  killed += reapOrphanMarkers();

  // Purge any stale network-capture body directories left by previous
  // SIGKILL'd processes (#896). Bodies persist on disk for the duration of an
  // active full-mode capture and are normally cleaned on `stop`; a hard kill
  // leaves them behind. We piggyback on the same startup hook that already
  // walks PIDs/markers so the cleanup runs exactly once per openchrome start.
  try {
    cleanupNetworkBodiesSync();
  } catch (err) {
    console.error(`${LOG_PREFIX} cleanupNetworkBodiesSync failed:`, err);
  }

  return killed;
}

/**
 * Marker-driven orphan reap (#661 Phase 5).
 * Performs a 4-way check before killing any process:
 *   1. PID alive?
 *   2. Identity match (cmdline contains the marker's --user-data-dir)?
 *   3. Parent MCP still alive AND still openchrome (PID-reuse defense)?
 *   4. Marker UUID consistent?
 * Mismatch on any check → leave the process alone, only delete the stale marker.
 *
 * Attach-mode Chromes are never reaped because attach mode never writes a marker.
 */
export function reapOrphanMarkers(): number {
  const items = listMarkers();
  if (items.length === 0) return 0;

  // Honor session-resume tokens (codex P1 review on #667). A token holding a
  // Chrome alive across an MCP restart must not be reaped on the next
  // startup, otherwise OPENCHROME_KILL_ON_EXIT=auto + token semantics break.
  const protectedChromePids = new Set<number>();
  try {
    const now = Date.now();
    for (const tok of listAllTokens()) {
      if (tok.ttlEpochMs > now) protectedChromePids.add(tok.chromePid);
    }
  } catch {
    // Best-effort: a missing/unreadable token store should not stop reaping.
  }

  let killed = 0;
  for (const { filePath, marker } of items) {
    if (protectedChromePids.has(marker.pid)) {
      // Active session-resume token covers this Chrome — leave alone.
      continue;
    }
    const decision = classifyMarker(marker);
    switch (decision) {
      case 'kill':
        console.error(`${LOG_PREFIX} Killing orphan Chrome PID ${marker.pid} (marker ${marker.marker.slice(0, 8)})`);
        try {
          killProcessTree(marker.pid, 'SIGTERM');
          killed++;
          // #857: mirror the orphan-reap on the lifecycle bus. Same
          // rationale as the PID-file path above — consumers need to tell
          // automated cleanup apart from user-driven close / crash.
          try {
            getLifecycleBus().emit({
              kind: 'chrome:exit',
              pid: marker.pid,
              reason: 'orphan-reap',
              ts: Date.now(),
            });
          } catch {
            /* bus is no-throw; defence in depth */
          }
        } catch {
          /* ignore */
        }
        deleteMarkerFile(filePath);
        break;
      case 'stale-marker':
        deleteMarkerFile(filePath);
        break;
      case 'parent-alive':
      case 'identity-mismatch':
      case 'unknown':
      default:
        // Leave the process alone.
        break;
    }
  }
  return killed;
}

export type MarkerDecision = 'kill' | 'stale-marker' | 'parent-alive' | 'identity-mismatch' | 'unknown';

/** Pure decision: what should the reaper do with a given marker? */
export function classifyMarker(marker: OwnershipMarker): MarkerDecision {
  // 1. Is the Chrome PID alive at all?
  if (!isPidAlive(marker.pid)) {
    return 'stale-marker';
  }

  // 2. Identity check: do the running process's args match the marker's user-data-dir?
  if (!verifyChromePidIdentity(marker.pid, marker.userDataDir)) {
    // PID was reused by something unrelated, or we can't verify (e.g. macOS truncation).
    // Conservative: do not kill.
    return 'identity-mismatch';
  }

  // 3. Is the parent MCP still alive?
  if (isPidAlive(marker.ppid)) {
    // Parent alive → still managed. Could be a quiesced Chrome (#660) or in-flight startup.
    return 'parent-alive';
  }

  // 4. Parent is dead and Chrome is alive: orphan we own.
  return 'kill';
}
