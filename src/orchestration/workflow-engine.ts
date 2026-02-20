/**
 * Workflow Engine - Executes parallel browser workflows
 * Manages worker lifecycle and result aggregation
 */

import { getSessionManager } from '../session-manager';
import { getOrchestrationStateManager, OrchestrationState, WorkerState } from './state-manager';

export interface WorkflowStep {
  workerId: string;
  workerName: string;
  url: string;
  task: string;
  successCriteria: string;
  shareCookies?: boolean;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
  parallel: boolean;
  maxRetries: number;
  timeout: number;
}

export interface WorkerResult {
  workerId: string;
  workerName: string;
  tabId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAIL';
  resultSummary: string;
  dataExtracted: unknown;
  iterations: number;
  errors: string[];
}

export interface WorkflowResult {
  orchestrationId: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  workerResults: WorkerResult[];
  completedCount: number;
  failedCount: number;
  duration: number;
}

/**
 * In-memory tracking state for a single workflow.
 * This is the source of truth for completion counting — file writes are write-behind
 * (for persistence/debugging only, not for correctness).
 */
interface InMemoryWorkflowState {
  orchestrationId: string;
  task: string;
  createdAt: number;
  totalWorkers: number;
  completedWorkers: number;
  failedWorkers: number;
  /** Status per worker: workerName → { status, resultSummary } */
  workerStatuses: Map<string, { status: WorkerState['status']; resultSummary: string }>;
  overallStatus: OrchestrationState['status'];
  allDone: boolean;
}

export class WorkflowEngine {
  private sessionManager = getSessionManager();
  private stateManager = getOrchestrationStateManager();

  /**
   * In-memory workflow state. Keyed by orchestrationId.
   * This is the source of truth for completion tracking — avoids file-based race conditions.
   */
  private workflowStates: Map<string, InMemoryWorkflowState> = new Map();

  /**
   * Promise-based mutex for serializing completeWorker operations.
   * Prevents lost-update races when multiple workers complete simultaneously.
   */
  private completionLock: Promise<void> = Promise.resolve();

  /**
   * Acquire the completion lock. Returns a release function.
   * All completeWorker calls are serialized through this lock.
   */
  private async acquireLock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    const prev = this.completionLock;
    this.completionLock = next;
    await prev;
    return release;
  }

  /**
   * Initialize a new workflow
   * Creates workers, tabs, and scratchpads
   */
  async initWorkflow(
    sessionId: string,
    workflow: WorkflowDefinition
  ): Promise<{
    orchestrationId: string;
    workers: Array<{ workerId: string; workerName: string; tabId: string }>;
  }> {
    const orchestrationId = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const workers = await Promise.all(
      workflow.steps.map(async (step) => {
        const worker = await this.sessionManager.createWorker(sessionId, {
          id: step.workerId,
          name: step.workerName,
          shareCookies: step.shareCookies,
          targetUrl: step.url,
        });

        const { targetId } = await this.sessionManager.createTarget(
          sessionId,
          step.url,
          worker.id
        );

        return {
          workerId: worker.id,
          workerName: step.workerName,
          tabId: targetId,
          task: step.task,
        };
      })
    );

    // Initialize file-based orchestration state (for scratchpads / debugging)
    await this.stateManager.initOrchestration(
      orchestrationId,
      workflow.name,
      workers
    );

    // Initialize in-memory state — this is the authoritative source for completion tracking
    const workerStatuses = new Map<string, { status: WorkerState['status']; resultSummary: string }>();
    for (const w of workers) {
      workerStatuses.set(w.workerName, { status: 'INIT', resultSummary: '' });
    }

    const memState: InMemoryWorkflowState = {
      orchestrationId,
      task: workflow.name,
      createdAt: Date.now(),
      totalWorkers: workers.length,
      completedWorkers: 0,
      failedWorkers: 0,
      workerStatuses,
      overallStatus: 'INIT',
      allDone: false,
    };
    this.workflowStates.set(orchestrationId, memState);

    console.error(`[WorkflowEngine] Initialized workflow ${orchestrationId} with ${workers.length} workers`);

    return {
      orchestrationId,
      workers: workers.map(w => ({
        workerId: w.workerId,
        workerName: w.workerName,
        tabId: w.tabId,
      })),
    };
  }

  /**
   * Update worker progress
   */
  async updateWorkerProgress(
    workerName: string,
    update: {
      status?: WorkerState['status'];
      iteration?: number;
      action?: string;
      result?: 'SUCCESS' | 'FAIL' | 'IN_PROGRESS';
      extractedData?: unknown;
      error?: string;
    }
  ): Promise<void> {
    if (update.status || update.iteration !== undefined || update.extractedData !== undefined) {
      await this.stateManager.updateWorkerState(workerName, {
        status: update.status,
        iteration: update.iteration,
        extractedData: update.extractedData,
      });
    }

    if (update.action && update.result) {
      await this.stateManager.addProgressEntry(
        workerName,
        update.action,
        update.result,
        update.error
      );
    }
  }

  /**
   * Mark worker as complete.
   *
   * Race-condition safe: all concurrent calls are serialized via a promise-based mutex.
   * In-memory state is the source of truth for completion counting; file writes are
   * write-behind (persistence/debugging only).
   */
  async completeWorker(
    workerName: string,
    status: 'SUCCESS' | 'PARTIAL' | 'FAIL',
    resultSummary: string,
    extractedData: unknown
  ): Promise<void> {
    // Update the worker scratchpad file (outside the lock — file writes per worker don't conflict)
    await this.stateManager.updateWorkerState(workerName, {
      status,
      extractedData,
    });

    // Serialize completion accounting through the lock to prevent lost updates
    const release = await this.acquireLock();
    try {
      // Find the in-memory workflow state that contains this worker
      let memState: InMemoryWorkflowState | undefined;
      for (const s of this.workflowStates.values()) {
        if (s.workerStatuses.has(workerName)) {
          memState = s;
          break;
        }
      }

      if (!memState) {
        // Fallback: no in-memory state (e.g. engine restarted). Fall back to file-based path.
        console.error(`[WorkflowEngine] No in-memory state for worker "${workerName}", falling back to file read`);
        await this._completeWorkerFileFallback(workerName, status, resultSummary);
        return;
      }

      const prev = memState.workerStatuses.get(workerName)!;
      const previousStatus = prev.status;
      const wasAlreadyCompleted =
        previousStatus === 'SUCCESS' || previousStatus === 'PARTIAL' || previousStatus === 'FAIL';

      // Update worker entry in-memory
      memState.workerStatuses.set(workerName, { status, resultSummary });

      // Adjust counters — prevent double-counting on repeated calls
      if (!wasAlreadyCompleted) {
        if (status === 'SUCCESS' || status === 'PARTIAL') {
          memState.completedWorkers++;
        } else if (status === 'FAIL') {
          memState.failedWorkers++;
        }
      } else {
        // Status transition between completed states — adjust counters accordingly
        const wasCompleted = previousStatus === 'SUCCESS' || previousStatus === 'PARTIAL';
        const wasFailed = previousStatus === 'FAIL';
        const isNowCompleted = status === 'SUCCESS' || status === 'PARTIAL';
        const isNowFailed = status === 'FAIL';

        if (wasCompleted && isNowFailed) {
          memState.completedWorkers--;
          memState.failedWorkers++;
        } else if (wasFailed && isNowCompleted) {
          memState.failedWorkers--;
          memState.completedWorkers++;
        }
        // Same category transition (e.g. SUCCESS→PARTIAL): no counter change needed
      }

      // Check if all workers are done
      const allDone = Array.from(memState.workerStatuses.values()).every(
        w => w.status === 'SUCCESS' || w.status === 'PARTIAL' || w.status === 'FAIL'
      );
      memState.allDone = allDone;

      if (allDone) {
        if (memState.failedWorkers === memState.totalWorkers) {
          memState.overallStatus = 'FAILED';
        } else if (memState.failedWorkers > 0) {
          memState.overallStatus = 'PARTIAL';
        } else {
          memState.overallStatus = 'COMPLETED';
        }
      } else {
        memState.overallStatus = 'RUNNING';
      }

      console.error(
        `[WorkflowEngine] Worker "${workerName}" completed with ${status}. ` +
        `Progress: ${memState.completedWorkers + memState.failedWorkers}/${memState.totalWorkers} ` +
        `(${memState.completedWorkers} ok, ${memState.failedWorkers} failed). ` +
        `Overall: ${memState.overallStatus}`
      );

      // Write-behind: persist to file for debugging/visibility (not for correctness)
      await this._writeOrchestrationStateBehind(memState);
    } finally {
      release();
    }
  }

  /**
   * Write orchestration state to file from in-memory state (write-behind).
   * This is for persistence/debugging only — correctness is maintained in memory.
   */
  private async _writeOrchestrationStateBehind(memState: InMemoryWorkflowState): Promise<void> {
    const workers = Array.from(memState.workerStatuses.entries()).map(([workerName, ws]) => ({
      workerId: workerName, // best-effort: workerId not stored separately in memState
      workerName,
      status: ws.status,
      resultSummary: ws.resultSummary,
    }));

    const orchState: OrchestrationState = {
      orchestrationId: memState.orchestrationId,
      status: memState.overallStatus,
      createdAt: memState.createdAt,
      updatedAt: Date.now(),
      task: memState.task,
      workers,
      completedWorkers: memState.completedWorkers,
      failedWorkers: memState.failedWorkers,
    };

    try {
      await this.stateManager.writeOrchestrationState(orchState);
    } catch (err) {
      // Write-behind failure is non-fatal — in-memory state remains correct
      console.error(`[WorkflowEngine] Write-behind failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Fallback for completeWorker when no in-memory state exists (engine restart scenario).
   * Uses the original file-based read-modify-write approach.
   */
  private async _completeWorkerFileFallback(
    workerName: string,
    status: 'SUCCESS' | 'PARTIAL' | 'FAIL',
    resultSummary: string
  ): Promise<void> {
    const orch = await this.stateManager.readOrchestrationState();
    if (!orch) return;

    const workerIdx = orch.workers.findIndex(w => w.workerName === workerName);
    if (workerIdx === -1) return;

    const previousStatus = orch.workers[workerIdx].status;
    const wasAlreadyCompleted =
      previousStatus === 'SUCCESS' || previousStatus === 'PARTIAL' || previousStatus === 'FAIL';

    orch.workers[workerIdx].status = status;
    orch.workers[workerIdx].resultSummary = resultSummary;

    if (!wasAlreadyCompleted) {
      if (status === 'SUCCESS' || status === 'PARTIAL') {
        orch.completedWorkers++;
      } else if (status === 'FAIL') {
        orch.failedWorkers++;
      }
    } else {
      const wasCompleted = previousStatus === 'SUCCESS' || previousStatus === 'PARTIAL';
      const wasFailed = previousStatus === 'FAIL';
      const isNowCompleted = status === 'SUCCESS' || status === 'PARTIAL';
      const isNowFailed = status === 'FAIL';

      if (wasCompleted && isNowFailed) {
        orch.completedWorkers--;
        orch.failedWorkers++;
      } else if (wasFailed && isNowCompleted) {
        orch.failedWorkers--;
        orch.completedWorkers++;
      }
    }

    const allDone = orch.workers.every(
      w => w.status === 'SUCCESS' || w.status === 'PARTIAL' || w.status === 'FAIL'
    );

    if (allDone) {
      if (orch.failedWorkers === orch.workers.length) {
        orch.status = 'FAILED';
      } else if (orch.failedWorkers > 0) {
        orch.status = 'PARTIAL';
      } else {
        orch.status = 'COMPLETED';
      }
    } else {
      orch.status = 'RUNNING';
    }

    await this.stateManager.writeOrchestrationState(orch);
  }

  /**
   * Get current orchestration status.
   * Returns in-memory state when available (most current); falls back to file.
   */
  async getOrchestrationStatus(): Promise<OrchestrationState | null> {
    // If there is exactly one active workflow in memory, return it
    if (this.workflowStates.size > 0) {
      // Return the most recently created workflow
      let latest: InMemoryWorkflowState | undefined;
      for (const s of this.workflowStates.values()) {
        if (!latest || s.createdAt > latest.createdAt) {
          latest = s;
        }
      }
      if (latest) {
        const workers = Array.from(latest.workerStatuses.entries()).map(([workerName, ws]) => ({
          workerId: workerName,
          workerName,
          status: ws.status,
          resultSummary: ws.resultSummary,
        }));
        return {
          orchestrationId: latest.orchestrationId,
          status: latest.overallStatus,
          createdAt: latest.createdAt,
          updatedAt: Date.now(),
          task: latest.task,
          workers,
          completedWorkers: latest.completedWorkers,
          failedWorkers: latest.failedWorkers,
        };
      }
    }
    // Fallback to file-based state (e.g. engine restarted)
    return this.stateManager.readOrchestrationState();
  }

  /**
   * Get all worker states
   */
  async getAllWorkerStates(): Promise<WorkerState[]> {
    return this.stateManager.getAllWorkerStates();
  }

  /**
   * Get worker state by name
   */
  async getWorkerState(workerName: string): Promise<WorkerState | null> {
    return this.stateManager.readWorkerState(workerName);
  }

  /**
   * Collect final results from all workers.
   * Uses in-memory orchestration status for correctness; reads per-worker detail from files.
   */
  async collectResults(): Promise<WorkflowResult | null> {
    const orch = await this.getOrchestrationStatus();
    if (!orch) return null;

    const workerResults: WorkerResult[] = [];
    const workerStates = await this.stateManager.getAllWorkerStates();

    for (const state of workerStates) {
      workerResults.push({
        workerId: state.workerId,
        workerName: state.workerName,
        tabId: state.tabId,
        status: state.status === 'SUCCESS' ? 'SUCCESS'
          : state.status === 'PARTIAL' ? 'PARTIAL'
          : 'FAIL',
        resultSummary: `${state.status}: ${state.iteration} iterations`,
        dataExtracted: state.extractedData,
        iterations: state.iteration,
        errors: state.errors,
      });
    }

    const completedCount = workerResults.filter(r => r.status === 'SUCCESS' || r.status === 'PARTIAL').length;
    const failedCount = workerResults.filter(r => r.status === 'FAIL').length;
    const duration = Date.now() - orch.createdAt;

    return {
      orchestrationId: orch.orchestrationId,
      status: orch.status === 'COMPLETED' ? 'COMPLETED'
        : orch.status === 'PARTIAL' ? 'PARTIAL'
        : 'FAILED',
      workerResults,
      completedCount,
      failedCount,
      duration,
    };
  }

  /**
   * Cleanup workflow resources
   */
  async cleanupWorkflow(sessionId: string): Promise<void> {
    // Get all workers from orchestration state
    const orch = await this.getOrchestrationStatus();
    if (!orch) return;

    // Delete workers (which closes tabs and contexts)
    for (const worker of orch.workers) {
      try {
        await this.sessionManager.deleteWorker(sessionId, worker.workerId);
      } catch {
        // Worker might already be deleted
      }
    }

    // Remove in-memory state for this workflow
    this.workflowStates.delete(orch.orchestrationId);

    // Cleanup state files
    await this.stateManager.cleanup();

    console.error(`[WorkflowEngine] Cleaned up workflow resources`);
  }

  /**
   * Generate worker agent prompt for Background Task
   */
  generateWorkerPrompt(
    workerId: string,
    workerName: string,
    tabId: string,
    task: string,
    successCriteria: string
  ): string {
    return `## Chrome-Sisyphus Worker Agent

You are an autonomous browser automation worker. Execute your assigned task completely before returning.

### Configuration
- Worker ID: ${workerId}
- Worker Name: ${workerName}
- Tab ID: ${tabId}
- Scratchpad: .agent/chrome-sisyphus/worker-${workerName}.md

### Your Task
${task}

### Success Criteria
${successCriteria}

---

## CRITICAL RULES

1. **ALWAYS include tabId="${tabId}" in EVERY MCP tool call**
2. **Update scratchpad after EVERY action using Write tool**
3. **Maximum 5 iterations**
4. **Return compressed result only - NO screenshots or full DOM**

---

## Available MCP Tools

### Navigation
mcp__chrome-parallel__navigate
- url: string (required)
- tabId: "${tabId}" (required)

### Interaction
mcp__chrome-parallel__computer
- action: "left_click" | "type" | "screenshot" | "scroll" | "key"
- tabId: "${tabId}" (required)
- coordinate: [x, y] (for clicks)
- text: string (for typing)

### Page Reading
mcp__chrome-parallel__read_page
- tabId: "${tabId}" (required)
- filter: "interactive" | "all"

### Element Finding
mcp__chrome-parallel__find
- query: string (natural language)
- tabId: "${tabId}" (required)

### Form Input
mcp__chrome-parallel__form_input
- ref: string (element reference from find/read_page)
- value: string | boolean | number
- tabId: "${tabId}" (required)

### JavaScript Execution
mcp__chrome-parallel__javascript_tool
- action: "javascript_exec"
- text: string (JS code)
- tabId: "${tabId}" (required)

---

## Execution Algorithm (Ralph Loop)

for iteration in 1..5:
    1. Assess current state (read page or check scratchpad)
    2. Decide next action
    3. Execute MCP tool with tabId="${tabId}"
    4. Update scratchpad with Write tool
    5. Check if success criteria met -> if yes, return SUCCESS

---

## Final Output Format

When done, your LAST message MUST contain:

---RESULT---
{
  "status": "SUCCESS" | "PARTIAL" | "FAIL",
  "workerName": "${workerName}",
  "resultSummary": "Brief summary (max 100 chars)",
  "dataExtracted": {
    // Your extracted data here
  },
  "scratchpadPath": ".agent/chrome-sisyphus/worker-${workerName}.md",
  "iterations": 3,
  "errors": [],
  "EXIT_SIGNAL": true
}
---END---

---

## Error Handling

| Error | Strategy |
|-------|----------|
| Element not found | Try find with different query |
| Page timeout | Refresh and retry |
| Captcha | Report FAIL |
| Network error | Wait 2s, retry |

Now begin your task. Navigate to the target site and complete the assigned work.`;
  }
}

// Singleton instance
let workflowEngineInstance: WorkflowEngine | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!workflowEngineInstance) {
    workflowEngineInstance = new WorkflowEngine();
  }
  return workflowEngineInstance;
}
