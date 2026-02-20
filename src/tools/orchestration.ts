/**
 * Orchestration Tools - MCP tools for Chrome-Sisyphus workflow management
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getWorkflowEngine, WorkflowDefinition } from '../orchestration/workflow-engine';
import { getOrchestrationStateManager } from '../orchestration/state-manager';

// ============================================
// workflow_init - Initialize a new workflow
// ============================================

const workflowInitDefinition: MCPToolDefinition = {
  name: 'workflow_init',
  description: `Initialize a Chrome-Sisyphus workflow with multiple workers.
Creates isolated browser contexts for each worker and sets up scratchpad files.

Use this to prepare parallel browser operations before launching worker agents.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the workflow (e.g., "Price comparison")',
      },
      workers: {
        type: 'array',
        description: 'List of workers to create',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Worker name (e.g., "coupang", "11st")',
            },
            url: {
              type: 'string',
              description: 'Initial URL to navigate to',
            },
            task: {
              type: 'string',
              description: 'Task description for the worker',
            },
            successCriteria: {
              type: 'string',
              description: 'Criteria for task completion',
            },
            shareCookies: {
              type: 'boolean',
              description: 'If true, worker shares cookies from existing Chrome session instead of isolated context (default: false)',
            },
          },
          required: ['name', 'url', 'task'],
        },
      },
    },
    required: ['name', 'workers'],
  },
};

const workflowInitHandler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const engine = getWorkflowEngine();
  const name = args.name as string;
  const workerDefs = args.workers as Array<{
    name: string;
    url: string;
    task: string;
    successCriteria?: string;
    shareCookies?: boolean;
  }>;

  try {
    // Create workflow definition
    const workflow: WorkflowDefinition = {
      id: `wf-${Date.now()}`,
      name,
      steps: workerDefs.map((w, i) => ({
        workerId: `worker-${w.name}`,
        workerName: w.name,
        url: w.url,
        task: w.task,
        successCriteria: w.successCriteria || 'Task completed successfully',
        shareCookies: w.shareCookies ?? false,
      })),
      parallel: true,
      maxRetries: 3,
      timeout: 300000, // 5 minutes
    };

    // Initialize workflow
    const result = await engine.initWorkflow(sessionId, workflow);

    // Generate worker prompts for reference
    const workerPrompts = result.workers.map((w, i) => ({
      workerName: w.workerName,
      tabId: w.tabId,
      prompt: engine.generateWorkerPrompt(
        w.workerId,
        w.workerName,
        w.tabId,
        workflow.steps[i].task,
        workflow.steps[i].successCriteria
      ),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              orchestrationId: result.orchestrationId,
              status: 'INITIALIZED',
              workers: result.workers.map((w, i) => ({
                workerId: w.workerId,
                workerName: w.workerName,
                tabId: w.tabId,
                task: workflow.steps[i].task,
              })),
              scratchpadDir: '.agent/chrome-sisyphus',
              message: `Workflow initialized with ${result.workers.length} workers. Launch Background Tasks for each worker using the Task tool with run_in_background: true.`,
              workerPrompts,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error initializing workflow: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// ============================================
// workflow_status - Get workflow status
// ============================================

const workflowStatusDefinition: MCPToolDefinition = {
  name: 'workflow_status',
  description: `Get the current status of a Chrome-Sisyphus workflow.
Returns orchestration state and all worker states.`,
  inputSchema: {
    type: 'object',
    properties: {
      includeWorkerDetails: {
        type: 'boolean',
        description: 'Include full worker scratchpad details (default: false)',
      },
    },
    required: [],
  },
};

const workflowStatusHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const engine = getWorkflowEngine();
  const includeWorkerDetails = args.includeWorkerDetails as boolean ?? false;

  try {
    const orch = await engine.getOrchestrationStatus();
    if (!orch) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'NO_WORKFLOW', message: 'No active workflow found' }),
          },
        ],
      };
    }

    const result: Record<string, unknown> = {
      orchestrationId: orch.orchestrationId,
      status: orch.status,
      task: orch.task,
      workers: orch.workers,
      completedWorkers: orch.completedWorkers,
      failedWorkers: orch.failedWorkers,
      duration: Date.now() - orch.createdAt,
    };

    if (includeWorkerDetails) {
      const workerStates = await engine.getAllWorkerStates();
      result.workerDetails = workerStates.map(w => ({
        workerName: w.workerName,
        status: w.status,
        iteration: w.iteration,
        progressLog: w.progressLog,
        extractedData: w.extractedData,
        errors: w.errors,
      }));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting workflow status: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// ============================================
// workflow_collect - Collect workflow results
// ============================================

const workflowCollectDefinition: MCPToolDefinition = {
  name: 'workflow_collect',
  description: `Collect and aggregate results from all workers in the workflow.
Use this after all worker Background Tasks have completed.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const workflowCollectHandler: ToolHandler = async (
  _sessionId: string,
  _args: Record<string, unknown>
): Promise<MCPResult> => {
  const engine = getWorkflowEngine();

  try {
    const results = await engine.collectResults();
    if (!results) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'NO_RESULTS', message: 'No workflow results found' }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error collecting results: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// ============================================
// workflow_cleanup - Cleanup workflow resources
// ============================================

const workflowCleanupDefinition: MCPToolDefinition = {
  name: 'workflow_cleanup',
  description: `Clean up workflow resources including workers, tabs, and scratchpad files.
Use this after workflow completion or to abort a workflow.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const workflowCleanupHandler: ToolHandler = async (
  sessionId: string,
  _args: Record<string, unknown>
): Promise<MCPResult> => {
  const engine = getWorkflowEngine();

  try {
    await engine.cleanupWorkflow(sessionId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'CLEANED',
            message: 'Workflow resources cleaned up successfully',
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error cleaning up workflow: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// ============================================
// worker_update - Update worker progress
// ============================================

const workerUpdateDefinition: MCPToolDefinition = {
  name: 'worker_update',
  description: `Update a worker's progress in the orchestration scratchpad.
Call this from worker agents to report progress.`,
  inputSchema: {
    type: 'object',
    properties: {
      workerName: {
        type: 'string',
        description: 'Name of the worker',
      },
      status: {
        type: 'string',
        enum: ['INIT', 'IN_PROGRESS', 'SUCCESS', 'PARTIAL', 'FAIL'],
        description: 'Worker status',
      },
      iteration: {
        type: 'number',
        description: 'Current iteration number',
      },
      action: {
        type: 'string',
        description: 'Action being performed',
      },
      result: {
        type: 'string',
        enum: ['SUCCESS', 'FAIL', 'IN_PROGRESS'],
        description: 'Result of the action',
      },
      extractedData: {
        type: 'object',
        description: 'Data extracted so far',
      },
      error: {
        type: 'string',
        description: 'Error message if any',
      },
    },
    required: ['workerName'],
  },
};

const workerUpdateHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const engine = getWorkflowEngine();
  const workerName = args.workerName as string;

  try {
    await engine.updateWorkerProgress(workerName, {
      status: args.status as 'INIT' | 'IN_PROGRESS' | 'SUCCESS' | 'PARTIAL' | 'FAIL' | undefined,
      iteration: args.iteration as number | undefined,
      action: args.action as string | undefined,
      result: args.result as 'SUCCESS' | 'FAIL' | 'IN_PROGRESS' | undefined,
      extractedData: args.extractedData,
      error: args.error as string | undefined,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'UPDATED',
            workerName,
            message: `Worker ${workerName} progress updated`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error updating worker: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// ============================================
// worker_complete - Mark worker as complete
// ============================================

const workerCompleteDefinition: MCPToolDefinition = {
  name: 'worker_complete',
  description: `Mark a worker as complete with final results.
Call this from worker agents when task is done.`,
  inputSchema: {
    type: 'object',
    properties: {
      workerName: {
        type: 'string',
        description: 'Name of the worker',
      },
      status: {
        type: 'string',
        enum: ['SUCCESS', 'PARTIAL', 'FAIL'],
        description: 'Final status',
      },
      resultSummary: {
        type: 'string',
        description: 'Brief summary of results (max 100 chars)',
      },
      extractedData: {
        type: 'object',
        description: 'Final extracted data',
      },
    },
    required: ['workerName', 'status', 'resultSummary'],
  },
};

const workerCompleteHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const engine = getWorkflowEngine();
  const workerName = args.workerName as string;
  const status = args.status as 'SUCCESS' | 'PARTIAL' | 'FAIL';
  const resultSummary = args.resultSummary as string;
  const extractedData = args.extractedData;

  try {
    await engine.completeWorker(workerName, status, resultSummary, extractedData);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'COMPLETED',
            workerName,
            workerStatus: status,
            message: `Worker ${workerName} marked as ${status}`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error completing worker: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// ============================================
// Register all orchestration tools
// ============================================

export function registerOrchestrationTools(server: MCPServer): void {
  server.registerTool('workflow_init', workflowInitHandler, workflowInitDefinition);
  server.registerTool('workflow_status', workflowStatusHandler, workflowStatusDefinition);
  server.registerTool('workflow_collect', workflowCollectHandler, workflowCollectDefinition);
  server.registerTool('workflow_cleanup', workflowCleanupHandler, workflowCleanupDefinition);
  server.registerTool('worker_update', workerUpdateHandler, workerUpdateDefinition);
  server.registerTool('worker_complete', workerCompleteHandler, workerCompleteDefinition);

  console.error('[Orchestration] Registered 6 orchestration tools');
}
