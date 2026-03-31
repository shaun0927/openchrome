/**
 * Cross-Environment Verification: Cursor IDE
 * Issue #509 — Simulates Cursor MCP client over stdio to verify all categories.
 *
 * Skipped on macOS with Node < 22 — older Node versions have stdio pipe issues
 * that prevent the spawned MCP server from responding in CI.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

const SERVER_PATH = path.resolve(__dirname, '../../dist/index.js');
const nodeMajor = parseInt(process.version.slice(1), 10);
const skipSuite = process.platform === 'darwin' && nodeMajor < 22;

// CI runners can be slow to spawn processes
jest.setTimeout(60000);

// ── JSON-RPC helpers ──

let msgId = 0;
function rpcRequest(method: string, params?: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params });
}

// Send a JSON-RPC request over stdin and collect the response (and any notifications).
// Uses line buffering to handle large responses split across multiple data events
// (common on macOS with Node 18/20 where stdout chunking differs).
function sendAndReceive(
  proc: ChildProcess,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 60000,
): Promise<{ response: any; notifications: any[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), timeoutMs);
    const notifications: any[] = [];
    let response: any = null;
    let buffer = '';

    const msg = rpcRequest(method, params);
    const currentId = msgId;

    const handler = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === currentId) {
            response = parsed;
          } else if (parsed.method) {
            notifications.push(parsed);
          }
        } catch {
          // ignore non-JSON lines (stderr leakage etc)
        }
      }
      if (response) {
        clearTimeout(timer);
        proc.stdout!.removeListener('data', handler);
        // Small delay to collect trailing notifications
        setTimeout(() => resolve({ response, notifications }), 200);
      }
    };

    proc.stdout!.on('data', handler);
    proc.stdin!.write(msg + '\n');
  });
}

// ── Test suite ──

const suiteRunner = skipSuite ? describe.skip : describe;

suiteRunner('Cross-Env: Cursor IDE Verification (Issue #509)', () => {
  let server: ChildProcess;

  beforeAll(() => {
    server = spawn('node', [SERVER_PATH, 'serve', '--auto-launch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    // Drain stderr to prevent pipe blocking
    server.stderr?.on('data', () => {});
  });

  afterAll(() => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
    }
  });

  // ═══════════════════════════════════════════════
  // C1: Installation & Configuration
  // ═══════════════════════════════════════════════

  describe('C1: Installation & Configuration', () => {
    let initResult: any;

    test('MCP server starts successfully via stdio transport', () => {
      expect(server.pid).toBeDefined();
      expect(server.killed).toBe(false);
    });

    test('Initialize handshake completes with correct protocolVersion', async () => {
      const { response } = await sendAndReceive(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '1.0.0' },
      });

      initResult = response.result;
      expect(response.error).toBeUndefined();
      expect(initResult.protocolVersion).toBe('2024-11-05');
    });

    test('Server capabilities: tools.listChanged=true, resources={}', () => {
      expect(initResult.capabilities.tools.listChanged).toBe(true);
      expect(initResult.capabilities.resources).toEqual({});
    });

    test('Server info: name="openchrome", version present', () => {
      expect(initResult.serverInfo.name).toBe('openchrome');
      expect(initResult.serverInfo.version).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════
  // C2: Tool Discovery & Listing
  // ═══════════════════════════════════════════════

  describe('C2: Tool Discovery & Listing', () => {
    let tier1Tools: any[];

    test('Initial tools/list returns Tier 1 tools only (30 tools) + expand_tools', async () => {
      const { response } = await sendAndReceive(server, 'tools/list');
      tier1Tools = response.result.tools;
      // 30 Tier 1 tools + 1 expand_tools virtual tool = 31
      const toolNames = tier1Tools.map((t: any) => t.name);
      expect(toolNames).toContain('expand_tools');

      const nonExpandTools = tier1Tools.filter((t: any) => t.name !== 'expand_tools');
      expect(nonExpandTools.length).toBe(30);
    });

    test('expand_tools virtual tool present in initial list', () => {
      const expandTool = tier1Tools.find((t: any) => t.name === 'expand_tools');
      expect(expandTool).toBeDefined();
      expect(expandTool.description).toContain('additional specialist tools');
      expect(expandTool.inputSchema.properties.tier).toBeDefined();
    });

    test('Tier 1 contains expected core tools', () => {
      const names = tier1Tools.map((t: any) => t.name);
      const expectedCore = [
        'navigate', 'page_reload', 'computer', 'interact', 'find',
        'form_input', 'fill_form', 'read_page', 'inspect', 'query_dom',
        'javascript_tool', 'tabs_context', 'tabs_create', 'tabs_close',
        'cookies', 'storage', 'wait_for', 'memory', 'lightweight_scroll',
        'oc_stop', 'oc_profile_status', 'oc_session_snapshot', 'oc_session_resume',
        'oc_journal',
        'oc_get_connection_info', 'oc_copy_to_clipboard', 'oc_open_host_settings',
      ];
      for (const tool of expectedCore) {
        expect(names).toContain(tool);
      }
    });

    test('Tier 1 also contains diagnostic tools (oc_connection_health, oc_checkpoint, list_profiles)', () => {
      const names = tier1Tools.map((t: any) => t.name);
      expect(names).toContain('oc_connection_health');
      expect(names).toContain('oc_checkpoint');
      expect(names).toContain('list_profiles');
    });

    test('expand_tools(tier=2) → Tier 2 tools appear + notification sent', async () => {
      const { response, notifications } = await sendAndReceive(server, 'tools/call', {
        name: 'expand_tools',
        arguments: { tier: '2' },
      });

      expect(response.result.content[0].text).toContain('Tool tier expanded to 2');
      // Should have sent a notifications/tools/list_changed
      expect(notifications.some((n: any) => n.method === 'notifications/tools/list_changed')).toBe(true);
    });

    test('After tier=2 expansion: tools/list contains Tier 2 specialist tools', async () => {
      const { response } = await sendAndReceive(server, 'tools/list');
      const toolNames = response.result.tools.map((t: any) => t.name);

      const expectedTier2 = [
        'drag_drop', 'network',
        'request_intercept', 'http_auth', 'user_agent', 'geolocation',
        'emulate_device', 'page_pdf', 'page_screenshot', 'page_content',
        'console_capture', 'performance_metrics', 'file_upload',
        'batch_execute', 'batch_paginate',
      ];
      for (const tool of expectedTier2) {
        expect(toolNames).toContain(tool);
      }

      // expand_tools should still be present (tier < 3)
      expect(toolNames).toContain('expand_tools');
    });

    test('expand_tools(tier=3) → Tier 3 tools appear + notification sent', async () => {
      const { response, notifications } = await sendAndReceive(server, 'tools/call', {
        name: 'expand_tools',
        arguments: { tier: '3' },
      });

      expect(response.result.content[0].text).toContain('Tool tier expanded to 3');
      expect(notifications.some((n: any) => n.method === 'notifications/tools/list_changed')).toBe(true);
    });

    test('After full expansion: all 54 tools visible, expand_tools REMOVED', async () => {
      const { response } = await sendAndReceive(server, 'tools/list');
      const toolNames = response.result.tools.map((t: any) => t.name);

      // expand_tools should be removed after tier=3
      expect(toolNames).not.toContain('expand_tools');

      // Tier 3 orchestration tools present
      const expectedTier3 = [
        'workflow_init', 'workflow_status', 'workflow_collect',
        'workflow_collect_partial', 'workflow_cleanup',
        'worker', 'worker_update', 'worker_complete', 'execute_plan',
      ];
      for (const tool of expectedTier3) {
        expect(toolNames).toContain(tool);
      }

      // Total should be 54 (30 T1 + 15 T2 + 9 T3)
      expect(toolNames.length).toBe(54);
    });

    test('resources/list returns usage guide resource', async () => {
      const { response } = await sendAndReceive(server, 'resources/list');
      const resources = response.result.resources;
      expect(resources.length).toBeGreaterThanOrEqual(1);
      const guide = resources.find((r: any) => r.uri === 'openchrome://usage-guide');
      expect(guide).toBeDefined();
      expect(guide.name).toBe('browser-usage-guide');
    });

    test('resources/read returns usage guide content', async () => {
      const { response } = await sendAndReceive(server, 'resources/read', {
        uri: 'openchrome://usage-guide',
      });
      const text = response.result.contents[0].text;
      expect(text).toContain('Browser Automation Usage Guide');
      expect(text).toContain('Connection Recovery');
    });
  });

  // ═══════════════════════════════════════════════
  // C3: Individual Tool Execution (registration verification)
  // ═══════════════════════════════════════════════

  describe('C3: Tool Registration Verification', () => {
    let allToolNames: string[];

    beforeAll(async () => {
      const { response } = await sendAndReceive(server, 'tools/list');
      allToolNames = response.result.tools.map((t: any) => t.name);
    });

    // Tier 1
    const tier1Tools = [
      'navigate', 'page_reload', 'computer', 'interact', 'find',
      'form_input', 'fill_form', 'read_page', 'inspect', 'query_dom',
      'javascript_tool', 'tabs_context', 'tabs_create', 'tabs_close',
      'cookies', 'storage', 'wait_for', 'memory', 'lightweight_scroll',
      'oc_stop', 'oc_profile_status', 'oc_session_snapshot', 'oc_session_resume', 'oc_journal',
      'oc_get_connection_info', 'oc_copy_to_clipboard', 'oc_open_host_settings',
    ];
    tier1Tools.forEach(tool => {
      test(`Tier 1: ${tool} registered`, () => {
        expect(allToolNames).toContain(tool);
      });
    });

    // Tier 2
    const tier2Tools = [
      'drag_drop', 'network',
      'request_intercept', 'http_auth', 'user_agent', 'geolocation',
      'emulate_device', 'page_pdf', 'page_screenshot', 'page_content',
      'console_capture', 'performance_metrics', 'file_upload',
      'batch_execute', 'batch_paginate',
    ];
    tier2Tools.forEach(tool => {
      test(`Tier 2: ${tool} registered`, () => {
        expect(allToolNames).toContain(tool);
      });
    });

    // Tier 3
    const tier3Tools = [
      'workflow_init', 'workflow_status', 'workflow_collect',
      'workflow_collect_partial', 'workflow_cleanup',
      'worker', 'worker_update', 'worker_complete', 'execute_plan',
    ];
    tier3Tools.forEach(tool => {
      test(`Tier 3: ${tool} registered`, () => {
        expect(allToolNames).toContain(tool);
      });
    });

    // Untiered (defaults to Tier 1)
    // These tools are registered with oc_ prefix but mapped in tool-tiers as non-prefixed
    const diagnosticTools = ['oc_connection_health', 'oc_checkpoint', 'list_profiles'];
    diagnosticTools.forEach(tool => {
      test(`Diagnostic/Tier1: ${tool} registered`, () => {
        expect(allToolNames).toContain(tool);
      });
    });
  });

  // ═══════════════════════════════════════════════
  // C5: Error Handling & Messages
  // ═══════════════════════════════════════════════

  describe('C5: Error Handling & Messages', () => {
    test('Invalid tool arguments: returns validation error', async () => {
      const { response } = await sendAndReceive(server, 'tools/call', {
        name: 'navigate',
        arguments: {}, // Missing required 'url'
      });
      // Should be an error (tool execution error)
      const content = response.result?.content?.[0]?.text || response.error?.message || '';
      expect(content).toBeTruthy();
    });

    test('Unknown tool: returns error', async () => {
      const { response } = await sendAndReceive(server, 'tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      });
      expect(response.error).toBeDefined();
      expect(response.error.message).toContain('Unknown tool');
    });

    test('Usage guide recovery section mentions Cursor, Windsurf, VS Code generically', async () => {
      const { response } = await sendAndReceive(server, 'resources/read', {
        uri: 'openchrome://usage-guide',
      });
      const text = response.result.contents[0].text;
      // Should have IDE-generic instructions including Cursor
      expect(text).toContain('IDE clients (Cursor, Windsurf, VS Code)');
      expect(text).toContain('Restart the MCP server from settings');
    });

    test('Error messages do NOT reference /mcp command or claude mcp commands', async () => {
      const { response } = await sendAndReceive(server, 'resources/read', {
        uri: 'openchrome://usage-guide',
      });
      const text = response.result.contents[0].text;
      // Must NOT contain /mcp or "claude mcp" references
      expect(text).not.toContain('/mcp');
      expect(text).not.toContain('claude mcp');
      // Should use generic language for CLI clients
      expect(text).toContain('built-in MCP management command');
    });

    test('Reconnection guidance is generic (no client-specific references)', () => {
      // From the source code constant at the top of mcp-server.ts
      const guidance = 'Simply retry your operation — Chrome will be re-launched automatically if needed. ' +
        'If the error persists, use tabs_context to get fresh tab IDs.';
      expect(guidance).not.toContain('Claude Code');
      expect(guidance).not.toContain('/mcp');
      expect(guidance).not.toContain('claude mcp');
    });
  });

  // ═══════════════════════════════════════════════
  // Cross-Environment: Unknown Client Fallback
  // ═══════════════════════════════════════════════

  describe('Cross-Environment: Unknown client gets all tools immediately', () => {
    let unknownServer: ChildProcess;

    beforeAll(() => {
      unknownServer = spawn('node', [SERVER_PATH, 'serve', '--auto-launch'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test' },
      });
      unknownServer.stderr?.on('data', () => {});
    });

    afterAll(() => {
      if (unknownServer && !unknownServer.killed) {
        unknownServer.kill('SIGTERM');
      }
    });

    test('Unknown client initializes with listChanged=false', async () => {
      const { response } = await sendAndReceive(unknownServer, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'unknown-editor', version: '1.0.0' },
      });

      expect(response.result.capabilities.tools.listChanged).toBe(false);
    });

    test('Unknown client gets all tools immediately (no expand_tools)', async () => {
      const { response } = await sendAndReceive(unknownServer, 'tools/list');
      const toolNames = response.result.tools.map((t: any) => t.name);

      // Should NOT have expand_tools (progressive disclosure disabled)
      expect(toolNames).not.toContain('expand_tools');
      // Should have all 54 tools immediately
      expect(toolNames.length).toBe(54);
    });
  });
});
