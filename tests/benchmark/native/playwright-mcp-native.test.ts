/// <reference types="jest" />
import { runPlaywrightMcpNativeTask } from './playwright-mcp-native';

describe('playwright-mcp native loop', () => {
  test('runs native navigate and snapshot sequence', async () => {
    const transport = { listTools: jest.fn(async () => ['browser_navigate', 'browser_snapshot']), callTool: jest.fn(async (name: string) => ({ content: [{ type: 'text', text: `${name} ok` }] })) };
    const result = await runPlaywrightMcpNativeTask(transport, { id: 't1', startUrl: 'http://x', goal: 'read', successText: 'browser_snapshot ok' });
    expect(result.status).toBe('passed');
    expect(transport.callTool).toHaveBeenNthCalledWith(1, 'browser_navigate', { url: 'http://x' });
    expect(transport.callTool).toHaveBeenNthCalledWith(2, 'browser_snapshot', {});
  });
  test('fails the task when the snapshot does not satisfy the goal evidence', async () => {
    const transport = { listTools: jest.fn(async () => ['browser_navigate', 'browser_snapshot']), callTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'wrong page' }] })) };

    const result = await runPlaywrightMcpNativeTask(transport, { id: 't1', startUrl: 'http://x', goal: 'checkout complete' });

    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('postcondition');
  });

  test('classifies discovery failures as infrastructure failures', async () => {
    const result = await runPlaywrightMcpNativeTask({ listTools: async () => { throw new Error('mcp down'); }, callTool: jest.fn() }, { id: 't1', startUrl: 'http://x', goal: 'read' });

    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('infrastructure');
    expect(result.trace[0]).toEqual(expect.objectContaining({ tool: 'transport', ok: false, error: 'mcp down' }));
  });

  test('accepts Set-valued tool discovery from stdio MCP clients', async () => {
    const transport = { listTools: jest.fn(async () => new Set(['browser_navigate', 'browser_snapshot'])), callTool: jest.fn(async (name: string) => ({ content: [{ type: 'text', text: `${name} ok` }] })) };

    const result = await runPlaywrightMcpNativeTask(transport, { id: 't1', startUrl: 'http://x', goal: 'read', successText: 'browser_snapshot ok' });

    expect(result.status).toBe('passed');
  });

  test('snapshots one-shot iterators before required tool membership checks', async () => {
    const discovered = ['browser_navigate', 'browser_snapshot'].values();
    const transport = { listTools: jest.fn(async () => discovered), callTool: jest.fn(async (name: string) => ({ content: [{ type: 'text', text: `${name} ok` }] })) };

    const result = await runPlaywrightMcpNativeTask(transport, { id: 't1', startUrl: 'http://x', goal: 'read', successText: 'browser_snapshot ok' });

    expect(result.status).toBe('passed');
  });

  test('reports unsupported when required tools are absent', async () => {
    const result = await runPlaywrightMcpNativeTask({ listTools: async () => ['browser_navigate'], callTool: jest.fn() }, { id: 't1', startUrl: 'http://x', goal: 'read' });
    expect(result.status).toBe('unsupported');
    expect(result.failureCategory).toMatch(/browser_snapshot/);
  });
});
