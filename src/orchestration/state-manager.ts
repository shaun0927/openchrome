/**
 * State Manager - Manages orchestration state for Chrome-Sisyphus
 * Provides file-based scratchpad management for workers
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// Constants for safety limits
const MAX_PROGRESS_LOG_ENTRIES = 500;
const MAX_WORKER_NAME_LENGTH = 100;

// Pattern for valid worker names (alphanumeric, dashes, underscores, and common unicode)
// Note: This is a simplified pattern that allows common characters without ES6 unicode regex
const VALID_WORKER_NAME_PATTERN = /^[a-zA-Z0-9_\-\u3131-\uD79D\u4E00-\u9FFF\u0400-\u04FF\u0600-\u06FF]+$/;

/**
 * Validate worker name for security and safety
 * Prevents path traversal and other injection attacks
 */
function validateWorkerName(workerName: string): { valid: boolean; error?: string } {
  if (!workerName || typeof workerName !== 'string') {
    return { valid: false, error: 'Worker name must be a non-empty string' };
  }

  if (workerName.length > MAX_WORKER_NAME_LENGTH) {
    return { valid: false, error: `Worker name exceeds maximum length of ${MAX_WORKER_NAME_LENGTH}` };
  }

  // Check for path traversal patterns
  if (workerName.includes('..') || workerName.includes('/') || workerName.includes('\\')) {
    return { valid: false, error: 'Worker name contains invalid path characters' };
  }

  // Check for null bytes and control characters
  if (/[\x00-\x1f]/.test(workerName)) {
    return { valid: false, error: 'Worker name contains control characters' };
  }

  // Validate against allowed pattern
  if (!VALID_WORKER_NAME_PATTERN.test(workerName)) {
    return { valid: false, error: 'Worker name contains invalid characters' };
  }

  return { valid: true };
}

export interface WorkerState {
  workerId: string;
  workerName: string;
  tabId: string;
  status: 'INIT' | 'IN_PROGRESS' | 'SUCCESS' | 'PARTIAL' | 'FAIL';
  iteration: number;
  maxIterations: number;
  startedAt: number;
  lastUpdatedAt: number;
  task: string;
  progressLog: ProgressEntry[];
  extractedData: unknown;
  errors: string[];
}

export interface ProgressEntry {
  iteration: number;
  timestamp: string;
  action: string;
  result: 'SUCCESS' | 'FAIL' | 'IN_PROGRESS';
  error?: string;
}

export interface OrchestrationState {
  orchestrationId: string;
  status: 'INIT' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  createdAt: number;
  updatedAt: number;
  task: string;
  workers: WorkerSummary[];
  completedWorkers: number;
  failedWorkers: number;
}

export interface WorkerSummary {
  workerId: string;
  workerName: string;
  status: WorkerState['status'];
  resultSummary?: string;
}

export class OrchestrationStateManager {
  private baseDir: string;

  constructor(baseDir: string = '.agent/chrome-sisyphus') {
    this.baseDir = baseDir;
  }

  /**
   * Ensure the orchestration directory exists
   */
  async ensureDirectory(): Promise<void> {
    const fullPath = path.resolve(this.baseDir);
    await fsp.mkdir(fullPath, { recursive: true });
  }

  /**
   * Initialize orchestration state
   */
  async initOrchestration(
    orchestrationId: string,
    task: string,
    workers: Array<{ workerId: string; workerName: string; tabId: string; task: string }>
  ): Promise<OrchestrationState> {
    await this.ensureDirectory();

    const state: OrchestrationState = {
      orchestrationId,
      status: 'INIT',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      task,
      workers: workers.map(w => ({
        workerId: w.workerId,
        workerName: w.workerName,
        status: 'INIT' as const,
      })),
      completedWorkers: 0,
      failedWorkers: 0,
    };

    // Initialize worker scratchpads
    for (const worker of workers) {
      await this.initWorkerState(worker.workerId, worker.workerName, worker.tabId, worker.task);
    }

    // Write orchestration state
    await this.writeOrchestrationState(state);

    return state;
  }

  /**
   * Initialize worker scratchpad
   */
  async initWorkerState(
    workerId: string,
    workerName: string,
    tabId: string,
    task: string
  ): Promise<WorkerState | null> {
    // Validate worker name for security
    const validation = validateWorkerName(workerName);
    if (!validation.valid) {
      console.error(`[StateManager] Invalid worker name "${workerName}": ${validation.error}`);
      return null;
    }

    await this.ensureDirectory();

    const state: WorkerState = {
      workerId,
      workerName,
      tabId,
      status: 'INIT',
      iteration: 0,
      maxIterations: 5,
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
      task,
      progressLog: [],
      extractedData: null,
      errors: [],
    };

    await this.writeWorkerState(workerName, state);
    return state;
  }

  /**
   * Update worker state
   */
  async updateWorkerState(
    workerName: string,
    update: Partial<WorkerState>
  ): Promise<WorkerState | null> {
    // Validate worker name before updating
    const validation = validateWorkerName(workerName);
    if (!validation.valid) {
      console.error(`[StateManager] Cannot update worker state: invalid name "${workerName}": ${validation.error}`);
      return null;
    }

    const current = await this.readWorkerState(workerName);
    if (!current) {
      console.error(`[StateManager] Cannot update worker state: worker "${workerName}" not found`);
      return null;
    }

    const updated: WorkerState = {
      ...current,
      ...update,
      lastUpdatedAt: Date.now(),
    };

    await this.writeWorkerState(workerName, updated);
    return updated;
  }

  /**
   * Add progress entry
   * Note: Progress log is limited to MAX_PROGRESS_LOG_ENTRIES to prevent unbounded growth
   */
  async addProgressEntry(
    workerName: string,
    action: string,
    result: ProgressEntry['result'],
    error?: string
  ): Promise<void> {
    const current = await this.readWorkerState(workerName);
    if (!current) {
      console.error(`[StateManager] Cannot add progress entry: worker "${workerName}" not found`);
      return;
    }

    const entry: ProgressEntry = {
      iteration: current.iteration,
      timestamp: new Date().toISOString(),
      action,
      result,
      error,
    };

    current.progressLog.push(entry);

    // Limit progress log size to prevent unbounded growth
    if (current.progressLog.length > MAX_PROGRESS_LOG_ENTRIES) {
      // Keep the most recent entries, remove oldest
      const removed = current.progressLog.length - MAX_PROGRESS_LOG_ENTRIES;
      current.progressLog = current.progressLog.slice(removed);
      console.error(`[StateManager] Progress log truncated for worker "${workerName}": removed ${removed} oldest entries`);
    }

    current.lastUpdatedAt = Date.now();

    await this.writeWorkerState(workerName, current);
  }

  /**
   * Read worker state from scratchpad
   */
  async readWorkerState(workerName: string): Promise<WorkerState | null> {
    // Validate worker name before reading
    const validation = validateWorkerName(workerName);
    if (!validation.valid) {
      console.error(`[StateManager] Cannot read worker state: invalid name "${workerName}": ${validation.error}`);
      return null;
    }

    const filePath = this.getWorkerPath(workerName);

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      // Try to parse JSON from markdown code block
      // Note: There may be multiple JSON blocks (extracted data + raw state)
      // We need the last one which contains the full state object
      const regex = /```json\n([\s\S]*?)\n```/g;
      let lastMatch: RegExpExecArray | null = null;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        lastMatch = match;
      }
      if (lastMatch) {
        // Get the last match (raw state)
        return JSON.parse(lastMatch[1]);
      }
      // Fallback: try parsing entire file as JSON
      return JSON.parse(content);
    } catch (error) {
      console.error(`[StateManager] Failed to parse worker state for "${workerName}": ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Write worker state to scratchpad (markdown format)
   */
  async writeWorkerState(workerName: string, state: WorkerState): Promise<void> {
    // Validate worker name before writing
    const validation = validateWorkerName(workerName);
    if (!validation.valid) {
      console.error(`[StateManager] Cannot write worker state: invalid name "${workerName}": ${validation.error}`);
      return;
    }

    const filePath = this.getWorkerPath(workerName);

    try {
      const markdown = this.formatWorkerMarkdown(state);
      await fsp.writeFile(filePath, markdown, 'utf-8');
    } catch (error) {
      console.error(`[StateManager] Failed to write worker state for "${workerName}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Format worker state as markdown
   */
  private formatWorkerMarkdown(state: WorkerState): string {
    const progressRows = state.progressLog.map(p => {
      const time = p.timestamp.split('T')[1]?.split('.')[0] || p.timestamp;
      const error = p.error || '-';
      return `| ${p.iteration} | ${time} | ${p.action} | ${p.result} | ${error} |`;
    });

    const progressTable = progressRows.length > 0
      ? progressRows.join('\n')
      : '| - | - | - | - | - |';

    const errorList = state.errors.length > 0
      ? state.errors.map(e => `- ${e}`).join('\n')
      : '(none)';

    const lastUpdated = new Date(state.lastUpdatedAt).toISOString();
    const extractedJson = JSON.stringify(state.extractedData, null, 2);
    const stateJson = JSON.stringify(state, null, 2);

    return `## Worker: ${state.workerName}
### Last Updated: ${lastUpdated}

### Meta
- Worker ID: ${state.workerId}
- Tab ID: ${state.tabId}
- Status: ${state.status}
- Iteration: ${state.iteration}/${state.maxIterations}

### Task
${state.task}

### Progress Log
| Iter | Time | Action | Result | Error |
|------|------|--------|--------|-------|
${progressTable}

### Extracted Data
\`\`\`json
${extractedJson}
\`\`\`

### Errors
${errorList}

---
<!-- Raw State (for parsing) -->
\`\`\`json
${stateJson}
\`\`\`
`;
  }

  /**
   * Read orchestration state
   */
  async readOrchestrationState(): Promise<OrchestrationState | null> {
    const filePath = this.getOrchestrationPath();

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      // Get the last JSON code block (the raw state)
      const regex = /```json\n([\s\S]*?)\n```/g;
      let lastMatch: RegExpExecArray | null = null;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        lastMatch = match;
      }
      if (lastMatch) {
        return JSON.parse(lastMatch[1]);
      }
      return JSON.parse(content);
    } catch (error) {
      console.error(`[StateManager] Failed to parse orchestration state: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Write orchestration state
   */
  async writeOrchestrationState(state: OrchestrationState): Promise<void> {
    const filePath = this.getOrchestrationPath();

    const markdown = this.formatOrchestrationMarkdown(state);
    await fsp.writeFile(filePath, markdown, 'utf-8');
  }

  /**
   * Update orchestration state
   */
  async updateOrchestrationState(update: Partial<OrchestrationState>): Promise<OrchestrationState | null> {
    const current = await this.readOrchestrationState();
    if (!current) return null;

    const updated: OrchestrationState = {
      ...current,
      ...update,
      updatedAt: Date.now(),
    };

    await this.writeOrchestrationState(updated);
    return updated;
  }

  /**
   * Format orchestration state as markdown
   */
  private formatOrchestrationMarkdown(state: OrchestrationState): string {
    const workerLines = state.workers.map(w => {
      let icon = '⏳';
      if (w.status === 'SUCCESS') icon = '✅';
      else if (w.status === 'FAIL') icon = '❌';
      const summary = w.resultSummary ? ` - ${w.resultSummary}` : '';
      return `- ${icon} ${w.workerName}: ${w.status}${summary}`;
    });

    const workerList = workerLines.join('\n');
    const lastUpdated = new Date(state.updatedAt).toISOString();
    const stateJson = JSON.stringify(state, null, 2);

    return `## Chrome-Sisyphus Orchestration
### Last Updated: ${lastUpdated}

### Status: ${state.status}

### Task
${state.task}

### Workers (${state.completedWorkers}/${state.workers.length} complete, ${state.failedWorkers} failed)
${workerList}

---
<!-- Raw State (for parsing) -->
\`\`\`json
${stateJson}
\`\`\`
`;
  }

  /**
   * Get all worker states
   */
  async getAllWorkerStates(): Promise<WorkerState[]> {
    const states: WorkerState[] = [];
    const orch = await this.readOrchestrationState();

    if (orch) {
      for (const worker of orch.workers) {
        const state = await this.readWorkerState(worker.workerName);
        if (state) {
          states.push(state);
        }
      }
    }

    return states;
  }

  /**
   * Get worker scratchpad path
   */
  getWorkerPath(workerName: string): string {
    return path.resolve(this.baseDir, `worker-${workerName}.md`);
  }

  /**
   * Get orchestration state path
   */
  getOrchestrationPath(): string {
    return path.resolve(this.baseDir, 'orchestration.md');
  }

  /**
   * Clean up orchestration files
   */
  async cleanup(): Promise<void> {
    const fullPath = path.resolve(this.baseDir);
    try {
      const files = await fsp.readdir(fullPath);
      await Promise.all(files.map(file => fsp.unlink(path.join(fullPath, file))));
    } catch {
      // Directory may not exist
    }
  }
}

// Singleton instance
let stateManagerInstance: OrchestrationStateManager | null = null;

export function getOrchestrationStateManager(baseDir?: string): OrchestrationStateManager {
  if (!stateManagerInstance) {
    stateManagerInstance = new OrchestrationStateManager(baseDir);
  }
  return stateManagerInstance;
}
