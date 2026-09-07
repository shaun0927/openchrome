import { execFile, execFileSync } from 'child_process';

export interface ProcessMemoryRow {
  pid: number;
  parentPid: number;
  residentBytes: number;
  startedAt: string;
}

export interface ProcessMemorySample {
  pid: number;
  identity: string;
  residentBytes: number;
  processCount: number;
  processIds: number[];
  timestamp: number;
  scope: 'process' | 'process-tree';
  metric: 'working-set' | 'rss';
}

function validPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process id');
}

export function parseProcessMemory(raw: string, platform: NodeJS.Platform): ProcessMemoryRow[] {
  if (!raw.trim()) throw new Error('Process memory collection returned no data');
  if (platform === 'win32') {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid Windows process record');
      const row = value as Record<string, unknown>;
      const pid = Number(row.ProcessId);
      const parentPid = Number(row.ParentProcessId);
      const residentBytes = Number(row.WorkingSetSize);
      const startedAt = typeof row.CreationDate === 'string' ? row.CreationDate : '';
      if (row.ProcessId == null || row.ParentProcessId == null || !Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(parentPid) || parentPid < 0 ||
          row.WorkingSetSize == null || !Number.isSafeInteger(residentBytes) || residentBytes < 0) {
        throw new Error('Invalid Windows process memory values');
      }
      return { pid, parentPid, residentBytes, startedAt };
    });
  }
  return raw.trim().split(/\r?\n/).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) throw new Error('Invalid ps process record');
    const residentBytes = Number(match[3]) * 1024;
    if (!Number.isSafeInteger(residentBytes)) throw new Error('Invalid ps memory value');
    return { pid: Number(match[1]), parentPid: Number(match[2]), residentBytes, startedAt: match[4] };
  });
}

export function selectProcessMemory(
  rows: ProcessMemoryRow[], pid: number, tree: boolean, platform: NodeJS.Platform,
): ProcessMemorySample {
  validPid(pid);
  const root = rows.find(row => row.pid === pid);
  if (!root || !root.startedAt || root.residentBytes <= 0) throw new Error(`Memory unavailable for process ${pid}`);
  const selected = new Set([pid]);
  if (tree) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!selected.has(row.pid) && selected.has(row.parentPid)) {
          selected.add(row.pid);
          changed = true;
        }
      }
    }
  }
  const residentBytes = rows.filter(row => selected.has(row.pid)).reduce((sum, row) => sum + row.residentBytes, 0);
  if (!Number.isSafeInteger(residentBytes)) throw new Error('Invalid aggregate process memory');
  return {
    pid, identity: `${pid}:${root.startedAt}`, residentBytes,
    processCount: selected.size, processIds: [...selected].sort((a, b) => a - b),
    timestamp: Date.now(), scope: tree ? 'process-tree' : 'process',
    metric: platform === 'win32' ? 'working-set' : 'rss',
  };
}

function command(pid: number, tree: boolean, platform: NodeJS.Platform): { file: string; args: string[] } {
  validPid(pid);
  if (platform === 'win32') {
    // No command lines, environment variables or credentials are collected.
    const filter = tree ? '' : ` -Filter 'ProcessId=${pid}'`;
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,WorkingSetSize,@{n='CreationDate';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''}}} | ConvertTo-Json -Compress`],
    };
  }
  return { file: 'ps', args: [...(tree ? ['-A'] : ['-p', String(pid)]), '-o', 'pid=,ppid=,rss=,lstart='] };
}

const options = { encoding: 'utf8' as const, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };

export function readProcessMemorySync(pid: number, tree = false): ProcessMemorySample {
  const platform = process.platform;
  const cmd = command(pid, tree, platform);
  const raw = execFileSync(cmd.file, cmd.args, options);
  return selectProcessMemory(parseProcessMemory(raw, platform), pid, tree, platform);
}

export function readProcessMemory(pid: number, tree = true, signal?: AbortSignal): Promise<ProcessMemorySample> {
  const platform = process.platform;
  const cmd = command(pid, tree, platform);
  return new Promise((resolve, reject) => {
    execFile(cmd.file, cmd.args, { ...options, signal }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(selectProcessMemory(parseProcessMemory(stdout, platform), pid, tree, platform)); }
      catch (parseError) { reject(parseError); }
    });
  });
}
