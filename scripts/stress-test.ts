#!/usr/bin/env ts-node
/**
 * Stress Test Script for openchrome
 * Tests concurrent sessions under load
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

interface StressTestConfig {
  sessionCount: number;
  operationsPerSession: number;
  reportIntervalMs: number;
}

interface StressTestResult {
  sessionId: string;
  operations: number;
  successes: number;
  failures: number;
  avgResponseTimeMs: number;
  maxResponseTimeMs: number;
  minResponseTimeMs: number;
}

interface OverallStats {
  totalOperations: number;
  totalSuccesses: number;
  totalFailures: number;
  avgResponseTimeMs: number;
  maxResponseTimeMs: number;
  minResponseTimeMs: number;
  durationMs: number;
  operationsPerSecond: number;
  memoryUsageMb: {
    initial: number;
    final: number;
    delta: number;
  };
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
        // Only log critical errors, not all stderr
        if (msg.includes('Error') || msg.includes('Failed')) {
          console.error('[Server Error]', msg.trim());
        }
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
          } catch {
            // Ignore parse errors for non-JSON output
          }
        }
      });

      this.process.on('error', reject);

      setTimeout(() => {
        if (!this.ready) reject(new Error('Timeout waiting for server'));
      }, 15000);
    });
  }

  async send(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<MCPResponse> {
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

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
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

function getMemoryUsageMb(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100;
}

async function runSessionOperations(
  client: MCPClient,
  sessionId: string,
  tabId: string,
  operationCount: number
): Promise<StressTestResult> {
  const responseTimes: number[] = [];
  let successes = 0;
  let failures = 0;

  const operations = [
    async (): Promise<MCPResponse> => {
      // Navigate
      return client.callTool(sessionId, 'navigate', {
        tabId,
        url: 'https://example.com'
      });
    },
    async (): Promise<MCPResponse> => {
      // Screenshot
      return client.callTool(sessionId, 'computer', {
        tabId,
        action: 'screenshot'
      });
    },
    async (): Promise<MCPResponse> => {
      // Read page
      return client.callTool(sessionId, 'read_page', {
        tabId,
        depth: 5
      });
    },
  ];

  for (let i = 0; i < operationCount; i++) {
    const operation = operations[i % operations.length];
    const startTime = Date.now();

    try {
      const response = await operation();
      if (response.error) {
        failures++;
      } else {
        successes++;
      }
    } catch {
      failures++;
    }

    responseTimes.push(Date.now() - startTime);
  }

  const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;

  return {
    sessionId,
    operations: operationCount,
    successes,
    failures,
    avgResponseTimeMs: Math.round(avgResponseTime),
    maxResponseTimeMs: Math.max(...responseTimes),
    minResponseTimeMs: Math.min(...responseTimes),
  };
}

async function runStressTest(config: StressTestConfig): Promise<void> {
  console.log('=== Claude Chrome Parallel Stress Test ===\n');
  console.log(`Configuration:`);
  console.log(`  Sessions: ${config.sessionCount}`);
  console.log(`  Operations per session: ${config.operationsPerSession}`);
  console.log(`  Total operations: ${config.sessionCount * config.operationsPerSession}`);
  console.log();

  const client = new MCPClient();
  const initialMemory = getMemoryUsageMb();

  try {
    console.log('Starting MCP server...');
    await client.start();
    console.log('Server started!\n');

    // Initialize
    await client.send('initialize', {});

    const startTime = Date.now();
    const results: StressTestResult[] = [];

    // Create tabs for all sessions
    console.log(`Creating ${config.sessionCount} sessions...`);
    const sessionSetup: { sessionId: string; tabId: string }[] = [];

    for (let i = 0; i < config.sessionCount; i++) {
      const sessionId = `stress-session-${i}`;
      const tabResponse = await client.callTool(sessionId, 'tabs_create_mcp', {});

      if ((tabResponse.result as { isError?: boolean })?.isError) {
        console.error(`Failed to create tab for session ${i}`);
        continue;
      }

      const content = (tabResponse.result as { content: { text: string }[] }).content[0].text;
      const tabId = JSON.parse(content).tabId;
      sessionSetup.push({ sessionId, tabId });

      if ((i + 1) % 5 === 0) {
        console.log(`  Created ${i + 1}/${config.sessionCount} sessions`);
      }
    }

    console.log(`\nRunning operations on ${sessionSetup.length} sessions in parallel...\n`);

    // Run operations in parallel for all sessions
    const operationPromises = sessionSetup.map(({ sessionId, tabId }) =>
      runSessionOperations(client, sessionId, tabId, config.operationsPerSession)
    );

    // Progress reporting
    let completed = 0;
    const progressInterval = setInterval(() => {
      console.log(`  Progress: ${completed}/${sessionSetup.length} sessions completed`);
    }, config.reportIntervalMs);

    // Wait for all sessions to complete
    for (const promise of operationPromises) {
      const result = await promise;
      results.push(result);
      completed++;
    }

    clearInterval(progressInterval);

    const endTime = Date.now();
    const finalMemory = getMemoryUsageMb();

    // Calculate overall stats
    const allResponseTimes = results.flatMap(r => [r.avgResponseTimeMs]);
    const overallStats: OverallStats = {
      totalOperations: results.reduce((sum, r) => sum + r.operations, 0),
      totalSuccesses: results.reduce((sum, r) => sum + r.successes, 0),
      totalFailures: results.reduce((sum, r) => sum + r.failures, 0),
      avgResponseTimeMs: Math.round(allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length),
      maxResponseTimeMs: Math.max(...results.map(r => r.maxResponseTimeMs)),
      minResponseTimeMs: Math.min(...results.map(r => r.minResponseTimeMs)),
      durationMs: endTime - startTime,
      operationsPerSecond: Math.round(
        (results.reduce((sum, r) => sum + r.operations, 0) / ((endTime - startTime) / 1000)) * 100
      ) / 100,
      memoryUsageMb: {
        initial: initialMemory,
        final: finalMemory,
        delta: Math.round((finalMemory - initialMemory) * 100) / 100,
      },
    };

    // Print results
    console.log('\n=== RESULTS ===\n');

    console.log('Per-Session Results:');
    console.log('─'.repeat(80));
    console.log(
      'Session'.padEnd(20) +
      'Ops'.padStart(8) +
      'Success'.padStart(10) +
      'Fail'.padStart(8) +
      'Avg(ms)'.padStart(10) +
      'Max(ms)'.padStart(10) +
      'Min(ms)'.padStart(10)
    );
    console.log('─'.repeat(80));

    for (const result of results) {
      console.log(
        result.sessionId.padEnd(20) +
        result.operations.toString().padStart(8) +
        result.successes.toString().padStart(10) +
        result.failures.toString().padStart(8) +
        result.avgResponseTimeMs.toString().padStart(10) +
        result.maxResponseTimeMs.toString().padStart(10) +
        result.minResponseTimeMs.toString().padStart(10)
      );
    }

    console.log('─'.repeat(80));

    console.log('\nOverall Statistics:');
    console.log('─'.repeat(40));
    console.log(`  Total Operations:    ${overallStats.totalOperations}`);
    console.log(`  Total Successes:     ${overallStats.totalSuccesses}`);
    console.log(`  Total Failures:      ${overallStats.totalFailures}`);
    console.log(`  Success Rate:        ${Math.round(overallStats.totalSuccesses / overallStats.totalOperations * 100)}%`);
    console.log(`  Duration:            ${overallStats.durationMs}ms (${Math.round(overallStats.durationMs / 1000)}s)`);
    console.log(`  Operations/sec:      ${overallStats.operationsPerSecond}`);
    console.log('─'.repeat(40));

    console.log('\nResponse Times:');
    console.log('─'.repeat(40));
    console.log(`  Average:             ${overallStats.avgResponseTimeMs}ms`);
    console.log(`  Maximum:             ${overallStats.maxResponseTimeMs}ms`);
    console.log(`  Minimum:             ${overallStats.minResponseTimeMs}ms`);
    console.log('─'.repeat(40));

    console.log('\nMemory Usage:');
    console.log('─'.repeat(40));
    console.log(`  Initial:             ${overallStats.memoryUsageMb.initial}MB`);
    console.log(`  Final:               ${overallStats.memoryUsageMb.final}MB`);
    console.log(`  Delta:               ${overallStats.memoryUsageMb.delta > 0 ? '+' : ''}${overallStats.memoryUsageMb.delta}MB`);
    console.log('─'.repeat(40));

    // Determine test result
    const successRate = overallStats.totalSuccesses / overallStats.totalOperations;
    const passed = successRate >= 0.95;

    console.log('\n' + '═'.repeat(40));
    if (passed) {
      console.log('  ✅ STRESS TEST PASSED');
    } else {
      console.log('  ❌ STRESS TEST FAILED');
      console.log(`     Success rate: ${Math.round(successRate * 100)}% (required: 95%)`);
    }
    console.log('═'.repeat(40) + '\n');

    if (!passed) {
      process.exitCode = 1;
    }

  } catch (error) {
    console.error('\nStress test failed:', error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const config: StressTestConfig = {
  sessionCount: 10,
  operationsPerSession: 10,
  reportIntervalMs: 5000,
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--sessions':
    case '-s':
      config.sessionCount = parseInt(args[++i], 10);
      break;
    case '--operations':
    case '-o':
      config.operationsPerSession = parseInt(args[++i], 10);
      break;
    case '--help':
    case '-h':
      console.log('Usage: stress-test.ts [options]');
      console.log('');
      console.log('Options:');
      console.log('  -s, --sessions <n>    Number of concurrent sessions (default: 10)');
      console.log('  -o, --operations <n>  Operations per session (default: 10)');
      console.log('  -h, --help            Show this help');
      process.exit(0);
  }
}

runStressTest(config).catch(console.error);
