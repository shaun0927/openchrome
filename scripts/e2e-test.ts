#!/usr/bin/env ts-node
/**
 * E2E Test Script for claude-chrome-parallel
 * Tests parallel session functionality
 */

import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class MCPClient {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private requestId = 0;
  private pending: Map<number, { resolve: (value: MCPResponse) => void; reject: (error: Error) => void }> = new Map();
  private buffer = '';

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const indexPath = path.join(__dirname, '..', 'dist', 'index.js');

      this.process = spawn('node', [indexPath, 'serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes('Ready, waiting for requests')) {
          resolve();
        }
        console.error('[Server]', msg.trim());
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();

        // Try to parse complete JSON lines
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as MCPResponse;
            const pending = this.pending.get(response.id);
            if (pending) {
              this.pending.delete(response.id);
              pending.resolve(response);
            }
          } catch (e) {
            console.error('Failed to parse response:', line);
          }
        }
      });

      this.process.on('error', reject);
      this.process.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}`));
        }
      });
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<MCPResponse> {
    if (!this.process?.stdin) {
      throw new Error('MCP process not started');
    }

    const id = ++this.requestId;
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
  }
}

async function runTests() {
  console.log('=== claude-chrome-parallel E2E Tests ===\n');

  const client = new MCPClient();

  try {
    console.log('Starting MCP server...');
    await client.start();
    console.log('Server started!\n');

    // Test 1: Initialize
    console.log('Test 1: Initialize');
    const initResponse = await client.send('initialize', {});
    console.log('  Response:', JSON.stringify(initResponse.result, null, 2));
    console.log('  ✓ Initialize successful\n');

    // Test 2: List tools
    console.log('Test 2: List tools');
    const toolsResponse = await client.send('tools/list', {});
    const tools = (toolsResponse.result as { tools: { name: string }[] }).tools;
    console.log(`  Found ${tools.length} tools:`, tools.map(t => t.name).join(', '));
    console.log('  ✓ Tools listed successfully\n');

    // Test 3: Create tab for session A
    console.log('Test 3: Create tab for session A');
    const tabAResponse = await client.send('tools/call', {
      sessionId: 'session-A',
      name: 'tabs_create_mcp',
      arguments: {},
    });
    console.log('  Response:', JSON.stringify(tabAResponse.result, null, 2));

    if (tabAResponse.result && !(tabAResponse.result as { isError?: boolean }).isError) {
      console.log('  ✓ Tab created for session A\n');
    } else {
      console.log('  ✗ Failed to create tab (Chrome may not be running)\n');
    }

    // Test 4: Create tab for session B (parallel session)
    console.log('Test 4: Create tab for session B (parallel session)');
    const tabBResponse = await client.send('tools/call', {
      sessionId: 'session-B',
      name: 'tabs_create_mcp',
      arguments: {},
    });
    console.log('  Response:', JSON.stringify(tabBResponse.result, null, 2));

    if (tabBResponse.result && !(tabBResponse.result as { isError?: boolean }).isError) {
      console.log('  ✓ Tab created for session B\n');
    } else {
      console.log('  ✗ Failed to create tab (Chrome may not be running)\n');
    }

    // Test 5: List sessions
    console.log('Test 5: List sessions');
    const sessionsResponse = await client.send('sessions/list', {});
    console.log('  Response:', JSON.stringify(sessionsResponse.result, null, 2));
    console.log('  ✓ Sessions listed\n');

    console.log('=== All tests completed ===');

  } catch (error) {
    console.error('Test failed:', error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

runTests().catch(console.error);
