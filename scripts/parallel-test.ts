#!/usr/bin/env ts-node
/**
 * Parallel Navigation Test for claude-chrome-parallel
 * Tests that multiple sessions can navigate simultaneously without interference
 */

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
  private requestId = 0;
  private pending: Map<number, { resolve: (value: MCPResponse) => void; reject: (error: Error) => void }> = new Map();
  private buffer = '';
  private ready = false;

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const indexPath = path.join(__dirname, '..', 'dist', 'index.js');

      this.process = spawn('node', [indexPath, 'serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        console.error('[Server]', msg.trim());
        if (msg.includes('Ready, waiting for requests')) {
          this.ready = true;
          resolve();
        }
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();

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

      setTimeout(() => {
        if (!this.ready) reject(new Error('Timeout waiting for server'));
      }, 10000);
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

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${id} timed out`));
        }
      }, 30000);
    });
  }

  async callTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<MCPResponse> {
    return this.send('tools/call', {
      sessionId,
      name,
      arguments: args,
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

async function runParallelTest() {
  console.log('=== Parallel Navigation Test ===\n');

  const client = new MCPClient();

  try {
    console.log('Starting MCP server...');
    await client.start();
    console.log('Server started!\n');

    // Initialize
    await client.send('initialize', {});

    // Create tabs for two sessions
    console.log('Creating tabs for parallel sessions...');

    const tabA = await client.callTool('session-A', 'tabs_create_mcp', {});
    const tabB = await client.callTool('session-B', 'tabs_create_mcp', {});

    const tabAContent = (tabA.result as { content: { text: string }[] }).content[0].text;
    const tabBContent = (tabB.result as { content: { text: string }[] }).content[0].text;

    const tabAId = JSON.parse(tabAContent).tabId;
    const tabBId = JSON.parse(tabBContent).tabId;

    console.log(`  Session A tab: ${tabAId}`);
    console.log(`  Session B tab: ${tabBId}`);
    console.log();

    // Navigate in parallel
    console.log('Navigating both tabs in parallel...');
    console.log('  Session A -> https://example.com');
    console.log('  Session B -> https://www.google.com');

    const startTime = Date.now();

    const [navA, navB] = await Promise.all([
      client.callTool('session-A', 'navigate', { tabId: tabAId, url: 'https://example.com' }),
      client.callTool('session-B', 'navigate', { tabId: tabBId, url: 'https://www.google.com' }),
    ]);

    const elapsed = Date.now() - startTime;
    console.log(`\nBoth navigations completed in ${elapsed}ms`);

    // Parse results
    const navAContent = (navA.result as { content: { text: string }[], isError?: boolean }).content[0].text;
    const navBContent = (navB.result as { content: { text: string }[], isError?: boolean }).content[0].text;

    if ((navA.result as { isError?: boolean }).isError) {
      console.log('  Session A: FAILED -', navAContent);
    } else {
      const navAResult = JSON.parse(navAContent);
      console.log(`  Session A: OK - ${navAResult.title} (${navAResult.url})`);
    }

    if ((navB.result as { isError?: boolean }).isError) {
      console.log('  Session B: FAILED -', navBContent);
    } else {
      const navBResult = JSON.parse(navBContent);
      console.log(`  Session B: OK - ${navBResult.title} (${navBResult.url})`);
    }

    // Take screenshots in parallel
    console.log('\nTaking screenshots in parallel...');

    const [ssA, ssB] = await Promise.all([
      client.callTool('session-A', 'computer', { tabId: tabAId, action: 'screenshot' }),
      client.callTool('session-B', 'computer', { tabId: tabBId, action: 'screenshot' }),
    ]);

    const ssAResult = ssA.result as { content: { type: string }[], isError?: boolean };
    const ssBResult = ssB.result as { content: { type: string }[], isError?: boolean };

    if (ssAResult.isError) {
      console.log('  Session A screenshot: FAILED');
    } else if (ssAResult.content[0].type === 'image') {
      console.log('  Session A screenshot: OK (image data received)');
    }

    if (ssBResult.isError) {
      console.log('  Session B screenshot: FAILED');
    } else if (ssBResult.content[0].type === 'image') {
      console.log('  Session B screenshot: OK (image data received)');
    }

    // Test session isolation - try to access session B tab from session A
    console.log('\nTesting session isolation...');
    console.log('  Attempting to navigate session B tab from session A...');

    const isolationTest = await client.callTool('session-A', 'navigate', {
      tabId: tabBId,
      url: 'https://evil.com',
    });

    const isolationResult = isolationTest.result as { content: { text: string }[], isError?: boolean };

    if (isolationResult.isError && isolationResult.content[0].text.includes('does not belong to session')) {
      console.log('  ✓ Session isolation working - access correctly denied');
    } else if (isolationResult.isError) {
      console.log('  ✓ Access denied (different error):', isolationResult.content[0].text);
    } else {
      console.log('  ✗ SECURITY ISSUE: Session isolation failed!');
    }

    // List sessions to verify
    console.log('\nFinal session state:');
    const sessionsResponse = await client.send('sessions/list', {});
    const sessionsContent = (sessionsResponse.result as { content: { text: string }[] }).content[0].text;
    const sessions = JSON.parse(sessionsContent);
    for (const session of sessions) {
      console.log(`  ${session.id}: ${session.targetCount} tab(s)`);
    }

    console.log('\n=== Parallel test completed successfully ===');

  } catch (error) {
    console.error('\nTest failed:', error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

runParallelTest().catch(console.error);
