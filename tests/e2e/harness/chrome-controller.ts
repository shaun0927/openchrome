/**
 * Chrome Process Controller for E2E tests.
 * Provides kill/restart/PID/memory monitoring of Chrome instances.
 */
import { execSync } from 'child_process';
import * as os from 'os';

export interface ChromeMemoryUsage {
  rss: number;
  heapUsed: number;
  heapTotal: number;
}

export class ChromeController {
  private chromePid: number | null = null;

  /**
   * Discover the Chrome process PID via debug port.
   */
  async discoverPid(debugPort: number = 9222): Promise<number> {
    const platform = os.platform();
    try {
      let output: string;
      if (platform === 'darwin') {
        output = execSync(`lsof -i :${debugPort} -t 2>/dev/null`, { encoding: 'utf-8' }).trim();
      } else if (platform === 'win32') {
        output = execSync(`netstat -ano | findstr :${debugPort} | findstr LISTENING`, { encoding: 'utf-8' }).trim();
        const parts = output.split(/\s+/);
        output = parts[parts.length - 1];
      } else {
        // Linux
        output = execSync(`lsof -i :${debugPort} -t 2>/dev/null || ss -tlnp | grep :${debugPort} | grep -oP 'pid=\\K\\d+'`, { encoding: 'utf-8' }).trim();
      }

      const pids = output.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));
      if (pids.length === 0) throw new Error(`No process found on port ${debugPort}`);

      this.chromePid = pids[0];
      return this.chromePid;
    } catch (err) {
      throw new Error(`Failed to discover Chrome PID on port ${debugPort}: ${(err as Error).message}`);
    }
  }

  /**
   * Kill Chrome process with given signal.
   */
  async kill(signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL'): Promise<void> {
    const pid = this.chromePid;
    if (!pid) throw new Error('No Chrome PID known. Call discoverPid() first.');

    try {
      process.kill(pid, signal);
      console.error(`[chrome-controller] Killed Chrome (pid: ${pid}, signal: ${signal})`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      // Process already dead
    }
  }

  /**
   * Wait for Chrome to relaunch (new process on debug port).
   * Returns new PID.
   */
  async waitForRelaunch(timeoutMs: number = 30_000, debugPort: number = 9222): Promise<number> {
    const oldPid = this.chromePid;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const newPid = await this.discoverPid(debugPort);
        if (newPid !== oldPid) {
          console.error(`[chrome-controller] Chrome relaunched (old: ${oldPid}, new: ${newPid})`);
          return newPid;
        }
      } catch {
        // Chrome not yet ready
      }
    }

    throw new Error(`Chrome did not relaunch within ${timeoutMs}ms`);
  }

  /**
   * Get current Chrome PID.
   */
  getPid(): number {
    if (!this.chromePid) throw new Error('No Chrome PID known');
    return this.chromePid;
  }

  /**
   * Check if Chrome process is running.
   */
  async isRunning(): Promise<boolean> {
    if (!this.chromePid) return false;
    try {
      process.kill(this.chromePid, 0); // signal 0 = check existence
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Chrome's memory usage via /proc or ps.
   * Returns RSS in bytes. Heap metrics from Node process (not Chrome).
   */
  async getMemoryUsage(): Promise<ChromeMemoryUsage> {
    const pid = this.chromePid;
    if (!pid) throw new Error('No Chrome PID known');

    const platform = os.platform();
    try {
      let rssKb: number;
      if (platform === 'darwin') {
        const output = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf-8' }).trim();
        rssKb = parseInt(output, 10);
      } else if (platform === 'win32') {
        const output = execSync(`wmic process where processid=${pid} get WorkingSetSize /format:value`, { encoding: 'utf-8' });
        const match = output.match(/WorkingSetSize=(\d+)/);
        rssKb = match ? parseInt(match[1], 10) / 1024 : 0;
      } else {
        const output = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf-8' }).trim();
        rssKb = parseInt(output, 10);
      }

      // Node process memory (for server-side heap monitoring)
      const nodeMemory = process.memoryUsage();

      return {
        rss: rssKb * 1024,
        heapUsed: nodeMemory.heapUsed,
        heapTotal: nodeMemory.heapTotal,
      };
    } catch (err) {
      throw new Error(`Failed to get memory for pid ${pid}: ${(err as Error).message}`);
    }
  }
}
