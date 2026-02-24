/// <reference types="jest" />
/**
 * Tests for MCP Server
 */

import { createMockSessionManager } from './utils/mock-session';

// Mock the session manager
jest.mock('../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../src/session-manager';
import { MCPServer } from '../src/mcp-server';
import { MCPRequest, MCPErrorCodes, MCPToolDefinition } from '../src/types/mcp';

// Helper type for response with result
interface MCPResultResponse {
  jsonrpc: string;
  id: number | string;
  result: {
    protocolVersion?: string;
    capabilities?: unknown;
    serverInfo?: { name: string; version: string };
    instructions?: string;
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
  };
}

describe('MCPServer', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let server: MCPServer;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    server = new MCPServer(mockSessionManager as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Protocol Handling', () => {
    describe('initialize', () => {
      test('returns protocol version and capabilities', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(1);
        expect(response.result).toBeDefined();
        expect(response.result!.protocolVersion).toBeDefined();
        expect(response.result!.capabilities).toBeDefined();
        expect(response.result!.serverInfo).toBeDefined();
        expect(response.result!.serverInfo!.name).toBe('openchrome');
      });

      test('returns server version', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.result!.serverInfo!.version).toBeDefined();
      });

      test('returns instructions field as a string', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.result!.instructions).toBeDefined();
        expect(typeof response.result!.instructions).toBe('string');
        expect(response.result!.instructions!.length).toBeGreaterThan(0);
      });

      test('instructions contain "oc" keyword trigger', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;
        const instructions = response.result!.instructions!;

        // Must mention "oc" as a trigger keyword
        expect(instructions).toContain('"oc"');
        expect(instructions).toMatch(/oc.*browser automation|browser automation.*oc/i);
      });

      test('instructions contain key behavioral rules', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;
        const instructions = response.result!.instructions!;

        // Must tell LLM not to attempt login
        expect(instructions).toMatch(/already logged in/i);
        expect(instructions).toMatch(/never attempt login/i);

        // Must mention parallel workflow
        expect(instructions).toContain('workflow_init');
        expect(instructions).toContain('workflow_collect');

        // Must mention tool preferences
        expect(instructions).toContain('click_element');
        expect(instructions).toContain('fill_form');

        // Must mention worker isolation
        expect(instructions).toMatch(/isolated browser context/i);
      });

      test('instructions contain workflow example', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;
        const instructions = response.result!.instructions!;

        // Must have at least one example with arrow notation
        expect(instructions).toContain('EXAMPLE');
        expect(instructions).toContain('→');
      });

      test('instructions reference key tools', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;
        const instructions = response.result!.instructions!;

        // Must reference essential tools inline
        const essentialTools = ['click_element', 'fill_form', 'workflow_init', 'workflow_collect'];
        for (const tool of essentialTools) {
          expect(instructions).toContain(tool);
        }
      });

      test('instructions do not contain Korean text', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;
        const instructions = response.result!.instructions!;

        // No Hangul characters (Unicode range AC00-D7AF for syllables, 1100-11FF for jamo)
        const koreanRegex = /[\uAC00-\uD7AF\u1100-\u11FF]/;
        expect(koreanRegex.test(instructions)).toBe(false);
      });
    });

    describe('initialized', () => {
      test('acknowledges initialized notification', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 2,
          method: 'initialized',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.result).toBeDefined();
        expect(response.error).toBeUndefined();
      });
    });

    describe('unknown method', () => {
      test('returns method not found error', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'unknown/method',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.error).toBeDefined();
        expect(response.error!.code).toBe(MCPErrorCodes.METHOD_NOT_FOUND);
        expect(response.error!.message).toContain('Unknown method');
      });
    });
  });

  describe('Tool Registration', () => {
    test('registers tools correctly', () => {
      const handler = jest.fn();
      const definition: MCPToolDefinition = {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      };

      server.registerTool('test_tool', handler, definition);

      expect(server.getToolNames()).toContain('test_tool');
    });

    test('returns registered tools via tools/list', async () => {
      const handler = jest.fn();
      const definition: MCPToolDefinition = {
        name: 'my_tool',
        description: 'My tool',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      };
      server.registerTool('my_tool', handler, definition);

      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      };

      const response = (await server.handleRequest(request)) as MCPResultResponse;

      expect(response.result!.tools).toBeDefined();
      expect(response.result!.tools!.length).toBeGreaterThan(0);
      expect(response.result!.tools!.some((t) => t.name === 'my_tool')).toBe(true);
    });
  });

  describe('Tool Execution', () => {
    test('calls tool handler with correct arguments', async () => {
      const handler = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Success' }],
      });

      const definition: MCPToolDefinition = {
        name: 'my_tool',
        description: 'Test tool',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      };
      server.registerTool('my_tool', handler, definition);

      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'my_tool',
          arguments: { foo: 'bar' },
          sessionId: 'test-session',
        },
      };

      await server.handleRequest(request);

      expect(handler).toHaveBeenCalledWith('test-session', { foo: 'bar' });
    });

    test('returns tool result', async () => {
      const handler = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Tool executed successfully' }],
      });

      const definition: MCPToolDefinition = {
        name: 'my_tool',
        description: 'Test tool',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      };
      server.registerTool('my_tool', handler, definition);

      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'my_tool',
          arguments: {},
        },
      };

      const response = (await server.handleRequest(request)) as MCPResultResponse;

      expect(response.result!.content).toBeDefined();
      expect(response.result!.content![0].text).toBe('Tool executed successfully');
    });

    test('returns error for unknown tool', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'nonexistent_tool',
          arguments: {},
        },
      };

      const response = (await server.handleRequest(request)) as MCPResultResponse;

      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Unknown tool');
    });

    test('returns error for missing tool name', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          arguments: {},
        },
      };

      const response = (await server.handleRequest(request)) as MCPResultResponse;

      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Missing tool name');
    });

    test('handles tool execution errors gracefully', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Tool failed'));

      const definition: MCPToolDefinition = {
        name: 'failing_tool',
        description: 'A failing tool',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      };
      server.registerTool('failing_tool', handler, definition);

      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'failing_tool',
          arguments: {},
        },
      };

      const response = (await server.handleRequest(request)) as MCPResultResponse;

      expect(response.result!.isError).toBe(true);
      expect(response.result!.content![0].text).toContain('Tool failed');
    });

    test('ensures session exists before tool execution', async () => {
      const handler = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
      });

      const definition: MCPToolDefinition = {
        name: 'my_tool',
        description: 'Test',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      };
      server.registerTool('my_tool', handler, definition);

      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'my_tool',
          arguments: {},
          sessionId: 'new-session-123',
        },
      };

      await server.handleRequest(request);

      expect(mockSessionManager.getOrCreateSession).toHaveBeenCalledWith('new-session-123');
    });
  });

  describe('Session Management APIs', () => {
    describe('sessions/list', () => {
      test('returns list of sessions', async () => {
        await mockSessionManager.createSession({ id: 'session-1', name: 'First' });
        await mockSessionManager.createSession({ id: 'session-2', name: 'Second' });

        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/list',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.result!.content).toBeDefined();
        const sessions = JSON.parse(response.result!.content![0].text);
        expect(sessions.length).toBe(2);
      });

      test('returns empty list when no sessions', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/list',
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        const sessions = JSON.parse(response.result!.content![0].text);
        expect(sessions).toEqual([]);
      });
    });

    describe('sessions/create', () => {
      test('creates new session with generated ID', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/create',
          params: {},
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        const result = JSON.parse(response.result!.content![0].text);
        expect(result.sessionId).toBeDefined();
      });

      test('creates session with specified ID', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/create',
          params: {
            sessionId: 'my-custom-session',
          },
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        const result = JSON.parse(response.result!.content![0].text);
        expect(result.sessionId).toBe('my-custom-session');
      });

      test('creates session with custom name', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/create',
          params: {
            name: 'My Named Session',
          },
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        const result = JSON.parse(response.result!.content![0].text);
        expect(result.name).toBe('My Named Session');
      });
    });

    describe('sessions/delete', () => {
      test('deletes existing session', async () => {
        await mockSessionManager.createSession({ id: 'to-delete' });

        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/delete',
          params: {
            sessionId: 'to-delete',
          },
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.result!.content![0].text).toContain('deleted');
        expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('to-delete');
      });

      test('returns error for missing sessionId', async () => {
        const request: MCPRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/delete',
          params: {},
        };

        const response = (await server.handleRequest(request)) as MCPResultResponse;

        expect(response.error).toBeDefined();
        expect(response.error!.message).toContain('Missing sessionId');
      });
    });
  });

  describe('Error Response Format', () => {
    test('includes correct jsonrpc version in error response', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 123,
        method: 'invalid/method',
      };

      const response = (await server.handleRequest(request)) as MCPResultResponse;

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(123);
    });

    test('preserves request ID in error response', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 'string-id-456',
        method: 'invalid/method',
      };

      const response = (await server.handleRequest(request)) as MCPResultResponse;

      expect(response.id).toBe('string-id-456');
    });
  });

  describe('getSessionManager', () => {
    test('returns the session manager instance', () => {
      const sm = server.getSessionManager();
      expect(sm).toBeDefined();
    });
  });

  describe('getToolNames', () => {
    test('returns empty array when no tools registered', () => {
      const newServer = new MCPServer(mockSessionManager as any);
      expect(newServer.getToolNames()).toEqual([]);
    });

    test('returns all registered tool names', () => {
      const definition1: MCPToolDefinition = {
        name: 'tool1',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
      };
      const definition2: MCPToolDefinition = {
        name: 'tool2',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
      };
      server.registerTool('tool1', jest.fn(), definition1);
      server.registerTool('tool2', jest.fn(), definition2);

      const names = server.getToolNames();

      expect(names).toContain('tool1');
      expect(names).toContain('tool2');
      expect(names.length).toBe(2);
    });
  });
});
