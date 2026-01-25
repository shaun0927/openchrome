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

export class WorkflowEngine {
  private sessionManager = getSessionManager();
  private stateManager = getOrchestrationStateManager();

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

    const workers: Array<{ workerId: string; workerName: string; tabId: string; task: string }> = [];

    // Create workers and tabs for each step
    for (const step of workflow.steps) {
      // Create isolated worker
      const worker = await this.sessionManager.createWorker(sessionId, {
        id: step.workerId,
        name: step.workerName,
      });

      // Create tab in worker context
      const { targetId } = await this.sessionManager.createTarget(
        sessionId,
        step.url,
        worker.id
      );

      workers.push({
        workerId: worker.id,
        workerName: step.workerName,
        tabId: targetId,
        task: step.task,
      });
    }

    // Initialize orchestration state
    await this.stateManager.initOrchestration(
      orchestrationId,
      workflow.name,
      workers
    );

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
   * Mark worker as complete
   * Note: This method prevents double-counting by checking the previous worker status
   */
  async completeWorker(
    workerName: string,
    status: 'SUCCESS' | 'PARTIAL' | 'FAIL',
    resultSummary: string,
    extractedData: unknown
  ): Promise<void> {
    await this.stateManager.updateWorkerState(workerName, {
      status,
      extractedData,
    });

    // Update orchestration state
    const orch = await this.stateManager.readOrchestrationState();
    if (orch) {
      const workerIdx = orch.workers.findIndex(w => w.workerName === workerName);
      if (workerIdx !== -1) {
        const previousStatus = orch.workers[workerIdx].status;
        const wasAlreadyCompleted = previousStatus === 'SUCCESS' || previousStatus === 'PARTIAL' || previousStatus === 'FAIL';

        orch.workers[workerIdx].status = status;
        orch.workers[workerIdx].resultSummary = resultSummary;

        // Only update counters if the worker wasn't already in a completed state
        // This prevents double-counting when completeWorker is called multiple times
        if (!wasAlreadyCompleted) {
          if (status === 'SUCCESS' || status === 'PARTIAL') {
            orch.completedWorkers++;
          }
          if (status === 'FAIL') {
            orch.failedWorkers++;
          }
        } else {
          // If status changed from one completed state to another, adjust counters
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
          // If both were completed or both were failed, no change needed
        }

        // Check if all workers are done
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
    }
  }

  /**
   * Get current orchestration status
   */
  async getOrchestrationStatus(): Promise<OrchestrationState | null> {
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
   * Collect final results from all workers
   */
  async collectResults(): Promise<WorkflowResult | null> {
    const orch = await this.stateManager.readOrchestrationState();
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
    const orch = await this.stateManager.readOrchestrationState();
    if (!orch) return;

    // Delete workers (which closes tabs and contexts)
    for (const worker of orch.workers) {
      try {
        await this.sessionManager.deleteWorker(sessionId, worker.workerId);
      } catch {
        // Worker might already be deleted
      }
    }

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
