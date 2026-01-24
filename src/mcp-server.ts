/**
 * MCP Server - Implements MCP protocol over stdio
 */

import * as readline from 'readline';
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

export class MCPServer {
  private tools: Map<string, ToolRegistry> = new Map();
  private sessionManager: SessionManager;
  private rl: readline.Interface | null = null;

  constructor(sessionManager?: SessionManager) {
    this.sessionManager = sessionManager || getSessionManager();
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
          result = await this.handleToolsCall(params);
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
   * Handle tools/call request
   */
  private async handleToolsCall(params?: Record<string, unknown>): Promise<MCPResult> {
    if (!params) {
      throw new Error('Missing params for tools/call');
    }

    const toolName = params.name as string;
    const toolArgs = (params.arguments || {}) as Record<string, unknown>;
    const sessionId = (toolArgs.sessionId || params.sessionId) as string;

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

    try {
      const result = await tool.handler(sessionId, toolArgs);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
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
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// Singleton instance
let mcpServerInstance: MCPServer | null = null;

export function getMCPServer(): MCPServer {
  if (!mcpServerInstance) {
    mcpServerInstance = new MCPServer();
  }
  return mcpServerInstance;
}
