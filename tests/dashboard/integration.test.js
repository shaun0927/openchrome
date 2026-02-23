#!/usr/bin/env node
/**
 * Integration Test - Tests MCP Server with Dashboard integration
 * (Non-TTY mode - dashboard will be disabled)
 */

const { MCPServer, setMCPServerOptions } = require('../../dist/mcp-server.js');
const { getSessionManager } = require('../../dist/session-manager.js');
const { ActivityTracker, OperationController } = require('../../dist/dashboard/index.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => {
        console.log(`✅ ${name}`);
        passed++;
      }).catch(error => {
        console.log(`❌ ${name}`);
        console.log(`   Error: ${error.message}`);
        failed++;
      });
    }
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected "${expected}", got "${actual}"`);
  }
}

function assertTrue(condition, msg = '') {
  if (!condition) {
    throw new Error(msg || 'Condition was false');
  }
}

async function runTests() {
  console.log('\n=== Integration Tests ===\n');

  await test('MCPServer - creates without dashboard', () => {
    setMCPServerOptions({ dashboard: false });
    const server = new (require('../../dist/mcp-server.js').MCPServer)();
    assertTrue(server !== null);
    assertEqual(server.isDashboardEnabled(), false);
  });

  await test('MCPServer - options are passed to constructor correctly', () => {
    // Pass options directly to constructor (not via singleton)
    const MCPServerClass = require('../../dist/mcp-server.js').MCPServer;
    const server = new MCPServerClass(undefined, { dashboard: true, dashboardRefreshInterval: 200 });
    // Dashboard object is created but won't start in non-TTY
    assertTrue(server.getDashboard() !== null, 'Dashboard object should be created');
  });

  await test('MCPServer - getSessionManager returns manager', () => {
    setMCPServerOptions({});
    const MCPServerClass = require('../../dist/mcp-server.js').MCPServer;
    const server = new MCPServerClass();
    const manager = server.getSessionManager();
    assertTrue(manager !== null);
  });

  await test('MCPServer - registerTool adds tools', () => {
    setMCPServerOptions({});
    const MCPServerClass = require('../../dist/mcp-server.js').MCPServer;
    const server = new MCPServerClass();
    server.registerTool('test_tool', async () => ({ content: [] }), {
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} }
    });
    const tools = server.getToolNames();
    assertTrue(tools.includes('test_tool'));
  });

  await test('MCPServer - handleRequest for initialize', async () => {
    setMCPServerOptions({});
    const MCPServerClass = require('../../dist/mcp-server.js').MCPServer;
    const server = new MCPServerClass();

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });

    assertEqual(response.jsonrpc, '2.0');
    assertEqual(response.id, 1);
    assertTrue(response.result !== undefined);
    assertTrue(response.result.protocolVersion !== undefined);
  });

  await test('MCPServer - handleRequest for tools/list', async () => {
    setMCPServerOptions({});
    const MCPServerClass = require('../../dist/mcp-server.js').MCPServer;
    const server = new MCPServerClass();

    server.registerTool('my_tool', async () => ({ content: [] }), {
      name: 'my_tool',
      description: 'My test tool',
      inputSchema: { type: 'object', properties: {} }
    });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });

    assertEqual(response.id, 2);
    assertTrue(Array.isArray(response.result.tools));
    assertTrue(response.result.tools.some(t => t.name === 'my_tool'));
  });

  await test('MCPServer - handleRequest for unknown method', async () => {
    setMCPServerOptions({});
    const MCPServerClass = require('../../dist/mcp-server.js').MCPServer;
    const server = new MCPServerClass();

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'unknown/method',
      params: {}
    });

    assertTrue(response.error !== undefined, 'Should return error');
    assertEqual(response.error.code, -32601); // METHOD_NOT_FOUND
  });

  await test('Activity tracking in tool calls', async () => {
    // Create a tracker and controller manually
    const tracker = new ActivityTracker();
    const controller = new OperationController();

    // Simulate what happens in handleToolsCall
    const callId = tracker.startCall('test_tool', 'sess-1', { arg1: 'value' });
    assertTrue(callId !== undefined);

    const activeCalls = tracker.getActiveCalls();
    assertEqual(activeCalls.length, 1);
    assertEqual(activeCalls[0].toolName, 'test_tool');

    // Simulate success
    tracker.endCall(callId, 'success');
    assertEqual(tracker.getActiveCalls().length, 0);
    assertEqual(tracker.getRecentCalls(10).length, 1);
    assertEqual(tracker.getRecentCalls(10)[0].result, 'success');
  });

  await test('Operation controller gate with pause/resume', async () => {
    const controller = new OperationController();

    // Normal operation
    const start = Date.now();
    await controller.gate();
    assertTrue(Date.now() - start < 50, 'Should pass immediately');

    // With pause
    controller.pause();
    let gatePassed = false;
    const gatePromise = controller.gate().then(() => { gatePassed = true; });

    // Wait a bit
    await new Promise(r => setTimeout(r, 20));
    assertEqual(gatePassed, false, 'Should be waiting');

    // Resume
    controller.resume();
    await gatePromise;
    assertEqual(gatePassed, true, 'Should pass after resume');
  });

  console.log('\n=== Summary ===\n');
  console.log(`Total: ${passed + failed} tests`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log();

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
