/// <reference types="jest" />
import { runPlaywrightMcpNativeTask } from './playwright-mcp-native';

describe('playwright-mcp native loop', () => {
  test('runs native navigate and snapshot sequence', async () => {
    const transport = { listTools: jest.fn(async () => ['browser_navigate', 'browser_snapshot']), callTool: jest.fn(async (name: string) => ({ content: [{ type: 'text', text: `${name} ok` }] })) };
    const result = await runPlaywrightMcpNativeTask(transport, { id: 't1', startUrl: 'http://x', goal: 'read' });
    expect(result.status).toBe('passed');
    expect(transport.callTool).toHaveBeenNthCalledWith(1, 'browser_navigate', { url: 'http://x' });
    expect(transport.callTool).toHaveBeenNthCalledWith(2, 'browser_snapshot', {});
  });
  test('classifies discovery failures as infrastructure failures', async () => {
    const result = await runPlaywrightMcpNativeTask({ listTools: async () => { throw new Error('mcp down'); }, callTool: jest.fn() }, { id: 't1', startUrl: 'http://x', goal: 'read' });

    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('infrastructure');
    expect(result.trace[0]).toEqual(expect.objectContaining({ tool: 'transport', ok: false, error: 'mcp down' }));
  });

  test('reports unsupported when required tools are absent', async () => {
    const result = await runPlaywrightMcpNativeTask({ listTools: async () => ['browser_navigate'], callTool: jest.fn() }, { id: 't1', startUrl: 'http://x', goal: 'read' });
    expect(result.status).toBe('unsupported');
    expect(result.failureCategory).toMatch(/browser_snapshot/);
  });
});
