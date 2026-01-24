/**
 * Worker MCP Server - MCP Server that uses RemoteSessionManager
 * This wraps the existing MCP server infrastructure but connects to Master for Chrome operations
 */

import * as readline from 'readline';
import { RemoteSessionManager } from './remote-session-manager';
import {
  MCPRequest,
  MCPResponse,
  MCPResult,
  MCPError,
  MCPToolDefinition,
  ToolHandler,
  ToolRegistry,
  MCPErrorCodes,
} from '../types/mcp';

export class WorkerMCPServer {
  private tools: Map<string, ToolRegistry> = new Map();
  private sessionManager: RemoteSessionManager;
  private rl: readline.Interface | null = null;
  private currentSessionId: string | null = null;

  constructor(sessionManager: RemoteSessionManager) {
    this.sessionManager = sessionManager;
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
    console.error('[WorkerMCPServer] Starting stdio server...');

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
      console.error('[WorkerMCPServer] stdin closed, shutting down...');
      process.exit(0);
    });

    console.error('[WorkerMCPServer] Ready, waiting for requests...');
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
    // Create initial session
    const session = await this.sessionManager.createSession({ name: 'default' });
    this.currentSessionId = session.id;

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
    let sessionId = (toolArgs.sessionId || params.sessionId) as string;

    if (!toolName) {
      throw new Error('Missing tool name');
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Ensure session exists
    if (!sessionId) {
      if (!this.currentSessionId) {
        const session = await this.sessionManager.createSession({ name: 'auto' });
        this.currentSessionId = session.id;
      }
      sessionId = this.currentSessionId;
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
    const sessions = await this.sessionManager.listSessions();
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
    const name = params?.name as string | undefined;

    const session = await this.sessionManager.createSession({ name });
    this.currentSessionId = session.id;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(session, null, 2),
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

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }

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
  getSessionManager(): RemoteSessionManager {
    return this.sessionManager;
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
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
