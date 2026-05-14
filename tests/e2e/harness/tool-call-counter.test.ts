import { ToolCallCounter, medianToolCallCount } from './tool-call-counter';
import type { MCPToolResult } from './mcp-client';

function result(text = 'ok', isError = false): MCPToolResult {
  return {
    text,
    raw: isError ? { isError: true } : {},
    content: [{ type: 'text', text }],
  };
}

describe('ToolCallCounter', () => {
  test('counts successful MCP tool calls between markers', async () => {
    const client = {
      callTool: jest.fn(async (name: string) => result(name)),
    };
    const counter = new ToolCallCounter(client);

    counter.start('phase-a');
    await counter.callTool('navigate', { url: 'file:///fixture.html' });
    await counter.callTool('interact', { ref: 'ref_1', action: 'click' }, 5000);
    const measurement = counter.stop();

    expect(measurement.label).toBe('phase-a');
    expect(measurement.count).toBe(2);
    expect(measurement.calls.map((call) => call.name)).toEqual(['navigate', 'interact']);
    expect(measurement.calls[1]).toMatchObject({ timeoutMs: 5000, ok: true });
  });

  test('records MCP isError responses and thrown client errors as calls', async () => {
    const client = {
      callTool: jest.fn(async (name: string) => {
        if (name === 'bad-tool') return result('tool failed', true);
        throw new Error('transport failed');
      }),
    };
    const counter = new ToolCallCounter(client);

    counter.start('failure-phase');
    await counter.callTool('bad-tool', {});
    await expect(counter.callTool('throws', {})).rejects.toThrow('transport failed');
    const measurement = counter.stop();

    expect(measurement.count).toBe(2);
    expect(measurement.calls[0]).toMatchObject({ name: 'bad-tool', ok: false, isError: true });
    expect(measurement.calls[1]).toMatchObject({ name: 'throws', ok: false, error: 'transport failed' });
  });

  test('measure attaches partial measurement to thrown phase errors', async () => {
    const client = { callTool: jest.fn(async () => result()) };
    const counter = new ToolCallCounter(client);

    await expect(counter.measure('phase-c', async (counted) => {
      await counted.callTool('navigate', {});
      throw new Error('contract failed');
    })).rejects.toMatchObject({
      message: 'contract failed',
      toolCallMeasurement: { label: 'phase-c', count: 1 },
    });
  });
});

describe('medianToolCallCount', () => {
  test('computes odd and even medians', () => {
    expect(medianToolCallCount([{ count: 6 }, { count: 2 }, { count: 7 }])).toBe(6);
    expect(medianToolCallCount([{ count: 1 }, { count: 3 }])).toBe(2);
  });
});
