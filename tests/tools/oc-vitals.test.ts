/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { MCPServer } from '../../src/mcp-server';
import { getSessionManager } from '../../src/session-manager';
import { registerOcVitalsTool } from '../../src/tools/oc-vitals';
import { TOOL_ANNOTATIONS } from '../../src/types/tool-annotations';

function makeServer(): { server: MCPServer; handler: Function } {
  const server = new MCPServer({} as any);
  registerOcVitalsTool(server);
  return { server, handler: server.getToolHandler('oc_vitals')! };
}

describe('oc_vitals tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('registers as a read-only tool with no dependency marker', async () => {
    const raw = {
      lcp: { valueMs: 1234, occurredAtMs: 1100, element: '@e7' },
      cls: { value: 0.05, largestShift: { valueMs: 12, value: 0.03 } },
      inp: { valueMs: 180, interactionCount: 3 },
      ttfb: { valueMs: 220 },
      fcp: { valueMs: 900 },
      collectedAtMs: 1400,
    };
    const page = { evaluate: jest.fn().mockResolvedValue(raw) };
    (getSessionManager as jest.Mock).mockReturnValue({ getPage: jest.fn().mockResolvedValue(page) });

    const { server, handler } = makeServer();
    expect(server.getToolNames()).toContain('oc_vitals');
    expect(TOOL_ANNOTATIONS.oc_vitals).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const result = await handler('session-1', { tabId: 'tab-1' });
    const data = JSON.parse(result.content[0].text);
    expect(data.structuredContent).toBeUndefined();
    expect(result.structuredContent).toEqual(data);
    expect(data.noDependency).toBe(true);
    expect(data.vitals.lcp).toEqual({ valueMs: 1234, rating: 'good', element: '@e7', occurredAtMs: 1100 });
    expect(data.vitals.cls.rating).toBe('good');
  });

  test('returns INP null reason when no interaction entries were captured', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        lcp: null,
        cls: { value: 0, largestShift: null },
        inp: null,
        inpNullReason: 'no-interaction',
        ttfb: { valueMs: 900 },
        fcp: { valueMs: 2500 },
        collectedAtMs: 100,
      }),
    };
    (getSessionManager as jest.Mock).mockReturnValue({ getPage: jest.fn().mockResolvedValue(page) });

    const { handler } = makeServer();
    const result = await handler('session-1', { tabId: 'tab-1' });
    const data = JSON.parse(result.content[0].text);
    expect(data.vitals.inp).toBeNull();
    expect(data.vitals.inpNullReason).toBe('no-interaction');
  });


  test('does not add the web-vitals package dependency', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json');
    expect(pkg.dependencies?.['web-vitals']).toBeUndefined();
    expect(pkg.devDependencies?.['web-vitals']).toBeUndefined();
  });

  test('rejects missing tabId before page lookup', async () => {
    const getPage = jest.fn();
    (getSessionManager as jest.Mock).mockReturnValue({ getPage });
    const { handler } = makeServer();
    const result = await handler('session-1', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tabId is required');
    expect(getPage).not.toHaveBeenCalled();
  });
});
