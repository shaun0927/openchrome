/**
 * Workflow Engine - Executes parallel browser workflows
 * Manages worker lifecycle and result aggregation
 */

import { getSessionManager } from '../session-manager';
import { getOrchestrationStateManager, OrchestrationState, WorkerState } from './state-manager';
import { getCDPConnectionPool } from '../cdp/connection-pool';
import { getCDPClient } from '../cdp/client';
import { ToolEntry } from '../types/tool-manifest';
import { getDomainMemory, extractDomainFromUrl } from '../memory/domain-memory';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';

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
  /** Maximum consecutive stale updates before circuit breaker triggers (default: 5) */
  maxStaleIterations?: number;
  /** Maximum total workflow execution time in ms (default: 300000) */
  globalTimeoutMs?: number;
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
  /** Per-worker timeout/circuit breaker config */
  workerTimeoutMs: number;
  maxStaleIterations: number;
  globalTimeoutMs: number;
}

/**
 * Per-worker runtime state for timeout and circuit breaker tracking
 */
interface WorkerRuntimeState {
  workerName: string;
  startTime: number;
  lastDataHash: string;
  staleCount: number;
  lastUpdateTime: number;
  timedOut: boolean;
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
   * Per-worker runtime state for timeout and circuit breaker tracking.
   * Keyed by workerName.
   */
  private workerRuntimeStates: Map<string, WorkerRuntimeState> = new Map();

  /**
   * Timeout handles for worker absolute timeouts. Keyed by workerName.
   */
  private workerTimeoutHandles: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Global workflow timeout handle. Keyed by orchestrationId.
   */
  private globalTimeoutHandles: Map<string, NodeJS.Timeout> = new Map();

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

    // Phase 1: Create all workers (no pages yet)
    const createdWorkers = await Promise.all(
      workflow.steps.map(async (step) => {
        const worker = await this.sessionManager.createWorker(sessionId, {
          id: step.workerId,
          name: step.workerName,
          shareCookies: step.shareCookies,
          targetUrl: step.url,
        });
        return { worker, step };
      })
    );

    // Phase 2: Batch-acquire pages from the pool to prevent about:blank proliferation.
    // acquireBatch suppresses per-page replenishment, avoiding 60-80 ghost tabs.
    const pool = getCDPConnectionPool();
    const batchPages = await pool.acquireBatch(createdWorkers.length);

    // Phase 3: Bridge cookies, then assign pages to workers and navigate
    const cdpClient = getCDPClient();
    const workers = await Promise.all(
      createdWorkers.map(async ({ worker, step }, i) => {
        const page = batchPages[i];

        // Bridge cookies from an authenticated page before navigating.
        // Pool pages are created with skipCookieBridge=true to avoid CDP session
        // conflicts during bulk creation. We bridge here sequentially after acquisition.
        if (step.url) {
          try {
            const targetHost = new URL(step.url).hostname;
            const authTargetId = await cdpClient.findAuthenticatedPageTargetId(targetHost);
            if (authTargetId) {
              await cdpClient.copyCookiesViaCDP(authTargetId, page);
            }
          } catch {
            // Cookie bridging failure is non-fatal — page navigates without cookies
          }

          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }).catch(() => {
            // Navigation may fail for some URLs; worker will retry
          });
        }

        // Register the page as a target in the session manager
        const targetId = (page.target() as unknown as { _targetId: string })._targetId;
        this.sessionManager.registerExistingTarget(sessionId, worker.id, targetId);

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

    const workerTimeoutMs = workflow.timeout || 60_000;
    const maxStaleIterations = workflow.maxStaleIterations ?? 5;
    const globalTimeoutMs = workflow.globalTimeoutMs ?? 300_000;
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
      workerTimeoutMs,
      maxStaleIterations,
      globalTimeoutMs,
    };
    this.workflowStates.set(orchestrationId, memState);

    // Initialize per-worker runtime state and set up timeouts
    for (const w of workers) {
      const runtimeState: WorkerRuntimeState = {
        workerName: w.workerName,
        startTime: Date.now(),
        lastDataHash: '',
        staleCount: 0,
        lastUpdateTime: Date.now(),
        timedOut: false,
      };
      this.workerRuntimeStates.set(w.workerName, runtimeState);

      // Set absolute timeout per worker
      const timeoutHandle = setTimeout(() => {
        this.forceCompleteWorker(w.workerName, 'timeout',
          `Worker exceeded max duration of ${workerTimeoutMs}ms`);
      }, workerTimeoutMs);
      timeoutHandle.unref();
      this.workerTimeoutHandles.set(w.workerName, timeoutHandle);
    }

    // Set global workflow timeout
    const globalHandle = setTimeout(() => {
      this.forceCompleteAllRunningWorkers(orchestrationId,
        `Global workflow timeout of ${memState.globalTimeoutMs}ms exceeded`);
    }, memState.globalTimeoutMs);
    globalHandle.unref();
    this.globalTimeoutHandles.set(orchestrationId, globalHandle);

    console.error(`[WorkflowEngine] Initialized workflow ${orchestrationId} with ${workers.length} workers (timeout: ${workerTimeoutMs}ms/worker, ${memState.globalTimeoutMs}ms global)`);

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
   * Update worker progress with circuit breaker check
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

    // Circuit breaker: check for stale data (no progress)
    if (update.extractedData !== undefined) {
      const runtimeState = this.workerRuntimeStates.get(workerName);
      if (runtimeState && !runtimeState.timedOut) {
        const newHash = this.hashData(update.extractedData);
        runtimeState.lastUpdateTime = Date.now();

        if (newHash === runtimeState.lastDataHash) {
          runtimeState.staleCount++;

          // Find max stale iterations from workflow config
          let maxStale = 5;
          for (const ws of this.workflowStates.values()) {
            if (ws.workerStatuses.has(workerName)) {
              maxStale = ws.maxStaleIterations;
              break;
            }
          }

          if (runtimeState.staleCount >= maxStale) {
            console.error(
              `[WorkflowEngine] Circuit breaker: Worker "${workerName}" data unchanged for ${maxStale} updates`
            );
            this.forceCompleteWorker(workerName, 'stale',
              `No data change for ${maxStale} consecutive updates`);
          }
        } else {
          runtimeState.staleCount = 0;
          runtimeState.lastDataHash = newHash;
        }
      }
    }
  }

  /**
   * Hash extracted data for circuit breaker comparison
   */
  private hashData(data: unknown): string {
    const str = JSON.stringify(data) ?? '';
    return str.length.toString() + '_' + str.slice(0, 200);
  }

  /**
   * Force-complete a single worker due to timeout or circuit breaker
   */
  private async forceCompleteWorker(
    workerName: string,
    reason: 'timeout' | 'stale',
    message: string
  ): Promise<void> {
    // Prevent double-completion
    const runtimeState = this.workerRuntimeStates.get(workerName);
    if (runtimeState) {
      if (runtimeState.timedOut) return;
      runtimeState.timedOut = true;
    }

    // Clear the timeout handle
    const handle = this.workerTimeoutHandles.get(workerName);
    if (handle) {
      clearTimeout(handle);
      this.workerTimeoutHandles.delete(workerName);
    }

    console.error(
      `[WorkflowEngine] Force-completing worker "${workerName}" (${reason}): ${message}`
    );

    // Complete with PARTIAL status — preserves any data collected so far
    await this.completeWorker(workerName, 'PARTIAL', `[${reason}] ${message}`, null);
  }

  /**
   * Force-complete all running workers in a workflow (global timeout)
   */
  private async forceCompleteAllRunningWorkers(
    orchestrationId: string,
    message: string
  ): Promise<void> {
    const memState = this.workflowStates.get(orchestrationId);
    if (!memState) return;

    console.error(`[WorkflowEngine] Global timeout for workflow ${orchestrationId}: ${message}`);

    const runningWorkers: string[] = [];
    for (const [workerName, ws] of memState.workerStatuses) {
      if (ws.status !== 'SUCCESS' && ws.status !== 'PARTIAL' && ws.status !== 'FAIL') {
        runningWorkers.push(workerName);
      }
    }

    for (const workerName of runningWorkers) {
      await this.forceCompleteWorker(workerName, 'timeout', message);
    }

    // Clear global timeout handle
    const handle = this.globalTimeoutHandles.get(orchestrationId);
    if (handle) {
      clearTimeout(handle);
      this.globalTimeoutHandles.delete(orchestrationId);
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

    // Clear all timeout handles for this workflow's workers
    for (const worker of orch.workers) {
      const handle = this.workerTimeoutHandles.get(worker.workerName);
      if (handle) {
        clearTimeout(handle);
        this.workerTimeoutHandles.delete(worker.workerName);
      }
      this.workerRuntimeStates.delete(worker.workerName);
    }

    // Clear global timeout
    const globalHandle = this.globalTimeoutHandles.get(orch.orchestrationId);
    if (globalHandle) {
      clearTimeout(globalHandle);
      this.globalTimeoutHandles.delete(orch.orchestrationId);
    }

    // Remove in-memory state for this workflow
    this.workflowStates.delete(orch.orchestrationId);

    // Cleanup state files
    await this.stateManager.cleanup();

    console.error(`[WorkflowEngine] Cleaned up workflow resources`);
  }

  /**
   * Generate MCP tool documentation from a ToolEntry array.
   * Groups tools by category and formats each tool with its parameters.
   */
  private generateToolDocs(tools: ToolEntry[], tabId: string): string {
    const categoryDisplayNames: Record<string, string> = {
      navigation: 'Navigation',
      interaction: 'Interaction',
      content: 'Content Reading',
      javascript: 'JavaScript Execution',
      composite: 'Smart Actions',
      network: 'Network',
      tabs: 'Tabs',
      media: 'Media',
      emulation: 'Emulation',
      orchestration: 'Orchestration',
      worker: 'Worker',
      performance: 'Performance',
      lifecycle: 'Lifecycle',
    };

    // Group tools by category
    const grouped: Record<string, ToolEntry[]> = {};
    for (const tool of tools) {
      const cat = tool.category as string;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(tool);
    }

    const sections: string[] = [];
    for (const [category, categoryTools] of Object.entries(grouped)) {
      const displayName = categoryDisplayNames[category] || category;
      const toolDocs: string[] = [];

      for (const tool of categoryTools) {
        const fullName = `mcp__openchrome__${tool.name}`;
        const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>;
        const paramLines: string[] = [];

        for (const [paramName, paramSchema] of Object.entries(props)) {
          if (paramName === 'tabId') continue; // handled separately below
          const paramType = paramSchema.type ?? 'unknown';
          const paramDesc = paramSchema.description ? ` — ${paramSchema.description}` : '';
          paramLines.push(`- ${paramName}: ${paramType}${paramDesc}`);
        }
        paramLines.push(`- tabId: "${tabId}" (required, always include)`);

        toolDocs.push(`**${fullName}**\n${tool.description}\nParameters:\n${paramLines.join('\n')}`);
      }

      sections.push(`### ${displayName}\n\n${toolDocs.join('\n\n')}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Generate worker agent prompt for Background Task
   */
  generateWorkerPrompt(
    workerId: string,
    workerName: string,
    tabId: string,
    task: string,
    successCriteria: string,
    manifestTools?: ToolEntry[],
    targetUrl?: string
  ): string {
    // CE: Isolate — inject only target domain's knowledge
    let domainKnowledgeSection = '';
    if (targetUrl) {
      const domain = extractDomainFromUrl(targetUrl);
      if (domain) {
        const entries = getDomainMemory().query(domain);
        if (entries.length > 0) {
          const lines = entries.map((e) => `- **${e.key}**: ${e.value} (confidence: ${e.confidence.toFixed(1)})`);
          domainKnowledgeSection = `\n\n## Domain Knowledge (${domain})\n\nPreviously learned knowledge for this domain. Validate after use with memory_validate.\n\n${lines.join('\n')}`;
        }
      }
    }

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

${manifestTools && manifestTools.length > 0
  ? `## Pre-loaded MCP Tools (verified — DO NOT call ToolSearch)

The following tools are pre-loaded and ready to use immediately.
CRITICAL: Do NOT call ToolSearch. These tool schemas are verified and current.

${this.generateToolDocs(manifestTools, tabId)}`
  : `## Available MCP Tools

### Navigation
mcp__openchrome__navigate
- url: string (required)
- tabId: "${tabId}" (required)

### Interaction
mcp__openchrome__computer
- action: "left_click" | "type" | "screenshot" | "scroll" | "key"
- tabId: "${tabId}" (required)
- coordinate: [x, y] (for clicks)
- text: string (for typing)

### Page Reading
mcp__openchrome__read_page
- tabId: "${tabId}" (required)
- filter: "interactive" | "all"

### Element Finding
mcp__openchrome__find
- query: string (natural language)
- tabId: "${tabId}" (required)

### Form Input
mcp__openchrome__form_input
- ref: string (element reference from find/read_page)
- value: string | boolean | number
- tabId: "${tabId}" (required)

### JavaScript Execution
mcp__openchrome__javascript_tool
- action: "javascript_exec"
- text: string (JS code)
- tabId: "${tabId}" (required)`}

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

Now begin your task. Navigate to the target site and complete the assigned work.${domainKnowledgeSection}`;
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
