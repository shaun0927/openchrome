/**
 * MCP Server - Implements MCP protocol over stdio
 */

import * as readline from 'readline';
import * as path from 'path';
import {
  MCPRequest,
  MCPResponse,
  MCPResult,
  MCPError,
  MCPToolDefinition,
  ToolHandler,
  ToolRegistry,
  MCPErrorCodes,
} from './types/mcp';
import { SessionManager, getSessionManager } from './session-manager';
import { Dashboard, getDashboard, ActivityTracker, getActivityTracker, OperationController } from './dashboard/index.js';
import { usageGuideResource, getUsageGuideContent, MCPResourceDefinition } from './resources/usage-guide';
import { HintEngine } from './hints';

export interface MCPServerOptions {
  dashboard?: boolean;
  dashboardRefreshInterval?: number;
}

export class MCPServer {
  private tools: Map<string, ToolRegistry> = new Map();
  private resources: Map<string, MCPResourceDefinition> = new Map();
  private sessionManager: SessionManager;
  private rl: readline.Interface | null = null;
  private dashboard: Dashboard | null = null;
  private activityTracker: ActivityTracker | null = null;
  private operationController: OperationController | null = null;
  private hintEngine: HintEngine | null = null;
  private options: MCPServerOptions;

  constructor(sessionManager?: SessionManager, options: MCPServerOptions = {}) {
    this.sessionManager = sessionManager || getSessionManager();
    this.options = options;

    // Register built-in resources
    this.registerResource(usageGuideResource);

    // Initialize dashboard if enabled
    if (options.dashboard) {
      this.initDashboard();
    }

    // Always-on activity tracking (uses singleton, shared with dashboard if enabled)
    if (!this.activityTracker) {
      this.activityTracker = getActivityTracker();
    }
    this.activityTracker.enableFileLogging(
      path.join(process.cwd(), '.chrome-parallel', 'timeline')
    );

    // Initialize hint engine with logging
    this.hintEngine = new HintEngine(this.activityTracker);
    this.hintEngine.enableLogging(
      path.join(process.cwd(), '.chrome-parallel', 'hints')
    );
  }

  /**
   * Register a resource
   */
  registerResource(resource: MCPResourceDefinition): void {
    this.resources.set(resource.uri, resource);
  }

  /**
   * Initialize the dashboard
   */
  private initDashboard(): void {
    this.dashboard = getDashboard({
      enabled: true,
      refreshInterval: this.options.dashboardRefreshInterval || 100,
    });
    this.dashboard.setSessionManager(this.sessionManager);
    this.activityTracker = this.dashboard.getActivityTracker();
    this.operationController = this.dashboard.getOperationController();

    // Handle quit event
    this.dashboard.on('quit', () => {
      console.error('[MCPServer] Dashboard quit requested');
      this.stop();
      process.exit(0);
    });

    // Handle delete session event
    this.dashboard.on('delete-session', async (sessionId: string) => {
      try {
        await this.sessionManager.deleteSession(sessionId);
        console.error(`[MCPServer] Session ${sessionId} deleted via dashboard`);
      } catch (error) {
        console.error(`[MCPServer] Failed to delete session: ${error}`);
      }
    });
  }

  /**
   * Register a tool
   */
  registerTool(
    name: string,
    handler: ToolHandler,
    definition: MCPToolDefinition
  ): void {
    this.tools.set(name, { name, handler, definition });
  }

  /**
   * Start the stdio server
   */
  start(): void {
    console.error('[MCPServer] Starting stdio server...');

    // Start dashboard if enabled
    if (this.dashboard) {
      const started = this.dashboard.start();
      if (started) {
        console.error('[MCPServer] Dashboard started');
      } else {
        console.error('[MCPServer] Dashboard could not start (non-TTY environment)');
      }
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on('line', async (line) => {
      if (!line.trim()) return;

      try {
        const request = JSON.parse(line) as MCPRequest;
        const response = await this.handleRequest(request);
        this.sendResponse(response);
      } catch (error) {
        const errorResponse: MCPResponse = {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: MCPErrorCodes.PARSE_ERROR,
            message: error instanceof Error ? error.message : 'Parse error',
          },
        };
        this.sendResponse(errorResponse);
      }
    });

    this.rl.on('close', () => {
      console.error('[MCPServer] stdin closed, shutting down...');
      this.stop();
      process.exit(0);
    });

    console.error('[MCPServer] Ready, waiting for requests...');
  }

  /**
   * Send response to stdout
   */
  private sendResponse(response: MCPResponse): void {
    console.log(JSON.stringify(response));
  }

  /**
   * Handle incoming MCP request
   */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    const requestReceivedAt = Date.now();
    const { id, method, params } = request;

    try {
      let result: MCPResult;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          break;

        case 'initialized':
          // Client acknowledgment, no response needed but we send confirmation
          result = {};
          break;

        case 'tools/list':
          result = await this.handleToolsList();
          break;

        case 'tools/call':
          result = await this.handleToolsCall(params, id);
          break;

        case 'resources/list':
          result = await this.handleResourcesList();
          break;

        case 'resources/read':
          result = await this.handleResourcesRead(params);
          break;

        case 'sessions/list':
          result = await this.handleSessionsList();
          break;

        case 'sessions/create':
          result = await this.handleSessionsCreate(params);
          break;

        case 'sessions/delete':
          result = await this.handleSessionsDelete(params);
          break;

        default:
          return this.errorResponse(id, MCPErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }

      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResponse(id, MCPErrorCodes.INTERNAL_ERROR, message);
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(_params?: Record<string, unknown>): Promise<MCPResult> {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: 'claude-chrome-parallel',
        version: '2.0.0',
      },
    };
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(): Promise<MCPResult> {
    const tools: MCPToolDefinition[] = [];
    for (const registry of this.tools.values()) {
      tools.push(registry.definition);
    }
    return { tools };
  }

  /**
   * Handle resources/list request
   */
  private async handleResourcesList(): Promise<MCPResult> {
    const resources: MCPResourceDefinition[] = [];
    for (const resource of this.resources.values()) {
      resources.push(resource);
    }
    return { resources };
  }

  /**
   * Handle resources/read request
   */
  private async handleResourcesRead(params?: Record<string, unknown>): Promise<MCPResult> {
    if (!params) {
      throw new Error('Missing params for resources/read');
    }

    const uri = params.uri as string;
    if (!uri) {
      throw new Error('Missing resource uri');
    }

    const resource = this.resources.get(uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    // Get content based on resource type
    let content: string;
    if (uri === 'chrome-parallel://usage-guide') {
      content = getUsageGuideContent();
    } else {
      throw new Error(`No content handler for resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: content,
        },
      ],
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(params?: Record<string, unknown>, requestId?: number | string): Promise<MCPResult> {
    if (!params) {
      throw new Error('Missing params for tools/call');
    }

    const toolName = params.name as string;
    const toolArgs = (params.arguments || {}) as Record<string, unknown>;
    // Use 'default' session if no sessionId is provided
    const sessionId = (toolArgs.sessionId || params.sessionId || 'default') as string;

    if (!toolName) {
      throw new Error('Missing tool name');
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Ensure session exists
    if (sessionId) {
      await this.sessionManager.getOrCreateSession(sessionId);
    }

    // Start activity tracking
    const callId = this.activityTracker!.startCall(toolName, sessionId || 'default', toolArgs, requestId);

    try {
      // Wait at gate if paused
      if (this.operationController) {
        await this.operationController.gate(callId);
      }

      const result = await tool.handler(sessionId, toolArgs);

      // End activity tracking (success)
      this.activityTracker!.endCall(callId, 'success');

      if (callId) {
        const timing = this.activityTracker!.getCall(callId);
        if (timing?.duration !== undefined) {
          (result as Record<string, unknown>)._timing = {
            durationMs: timing.duration,
            startTime: timing.startTime,
            endTime: timing.endTime,
          };
        }
      }

      // Inject anti-삽질 hint
      if (this.hintEngine) {
        const hint = this.hintEngine.getHint(toolName, result as Record<string, unknown>, false);
        if (hint) {
          (result as Record<string, unknown>)._hint = hint;
        }
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // End activity tracking (error)
      this.activityTracker!.endCall(callId, 'error', message);

      const errResult: MCPResult = {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };

      if (callId) {
        const timing = this.activityTracker!.getCall(callId);
        if (timing?.duration !== undefined) {
          (errResult as Record<string, unknown>)._timing = {
            durationMs: timing.duration,
            startTime: timing.startTime,
            endTime: timing.endTime,
          };
        }
      }

      // Inject anti-삽질 hint for errors
      if (this.hintEngine) {
        const hint = this.hintEngine.getHint(toolName, errResult as Record<string, unknown>, true);
        if (hint) {
          (errResult as Record<string, unknown>)._hint = hint;
        }
      }

      return errResult;
    }
  }

  /**
   * Handle sessions/list request
   */
  private async handleSessionsList(): Promise<MCPResult> {
    const sessions = this.sessionManager.getAllSessionInfos();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sessions, null, 2),
        },
      ],
    };
  }

  /**
   * Handle sessions/create request
   */
  private async handleSessionsCreate(params?: Record<string, unknown>): Promise<MCPResult> {
    const sessionId = params?.sessionId as string | undefined;
    const name = params?.name as string | undefined;

    const session = await this.sessionManager.createSession({
      id: sessionId,
      name,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              sessionId: session.id,
              name: session.name,
              targetCount: session.targets.size,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle sessions/delete request
   */
  private async handleSessionsDelete(params?: Record<string, unknown>): Promise<MCPResult> {
    const sessionId = params?.sessionId as string;
    if (!sessionId) {
      throw new Error('Missing sessionId');
    }

    await this.sessionManager.deleteSession(sessionId);

    return {
      content: [
        {
          type: 'text',
          text: `Session ${sessionId} deleted`,
        },
      ],
    };
  }

  /**
   * Create an error response
   */
  private errorResponse(
    id: number | string,
    code: number,
    message: string,
    data?: unknown
  ): MCPResponse {
    const error: MCPError = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    return {
      jsonrpc: '2.0',
      id,
      error,
    };
  }

  /**
   * Get the session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Stop the server
   */
  stop(): void {
    // Stop dashboard
    if (this.dashboard) {
      this.dashboard.stop();
    }

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Check if dashboard is enabled
   */
  isDashboardEnabled(): boolean {
    return this.dashboard !== null && this.dashboard.running;
  }

  /**
   * Get the dashboard instance
   */
  getDashboard(): Dashboard | null {
    return this.dashboard;
  }
}

// Singleton instance
let mcpServerInstance: MCPServer | null = null;
let mcpServerOptions: MCPServerOptions = {};

export function setMCPServerOptions(options: MCPServerOptions): void {
  mcpServerOptions = options;
}

export function getMCPServer(): MCPServer {
  if (!mcpServerInstance) {
    mcpServerInstance = new MCPServer(undefined, mcpServerOptions);
  }
  return mcpServerInstance;
}
