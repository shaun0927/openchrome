/// <reference types="jest" />

import { createMockSessionManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/shadow-dom', () => ({
  getAllShadowRoots: jest.fn().mockResolvedValue({ shadowRoots: [], domTree: {} }),
  querySelectorInShadowRoots: jest.fn().mockResolvedValue([]),
}));

import { getSessionManager } from '../../src/session-manager';

describe('InspectTool include_metrics', () => {
  test('keeps default inspect output unchanged without metrics', async () => {
    const mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    const sessionId = 'inspect-default-metrics-session';
    const { targetId, page } = await mockSessionManager.createTarget(sessionId, 'about:blank');
    (page.evaluate as jest.Mock).mockResolvedValue({
      focusedInfo: null,
      tabs: [],
      interactiveCounts: { button: 2 },
      formFields: [],
      headings: [],
      errors: [],
      visiblePanels: [],
      url: 'https://example.com',
      title: 'Example',
    });

    const { registerInspectTool } = await import('../../src/tools/inspect');
    const tools = new Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<any> }>();
    registerInspectTool({
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<any> });
      },
    } as unknown as Parameters<typeof registerInspectTool>[0]);

    const result = await tools.get('inspect')!.handler(sessionId, {
      tabId: targetId,
      query: 'interactive controls',
    });

    expect(result.content[0].text).toContain('[Interactive Elements] 2 buttons');
    expect(result.content[0].text).not.toContain('[openchrome_metrics]');
  });

  test('appends approximate token metrics only when requested', async () => {
    const mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    const sessionId = 'inspect-include-metrics-session';
    const { targetId, page } = await mockSessionManager.createTarget(sessionId, 'about:blank');
    (page.evaluate as jest.Mock).mockResolvedValue({
      focusedInfo: null,
      tabs: [],
      interactiveCounts: { button: 1, link: 3 },
      formFields: [],
      headings: [{ level: 1, text: 'Visible Heading' }],
      errors: [],
      visiblePanels: [],
      url: 'https://example.com/repo',
      title: 'Repository',
    });

    const { registerInspectTool } = await import('../../src/tools/inspect');
    const tools = new Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<any> }>();
    registerInspectTool({
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<any> });
      },
    } as unknown as Parameters<typeof registerInspectTool>[0]);

    const result = await tools.get('inspect')!.handler(sessionId, {
      tabId: targetId,
      query: 'headings and interactive controls',
      include_metrics: true,
    });
    const text = result.content[0].text as string;
    const [body, metricsLine] = text.split('\n\n[openchrome_metrics] ');
    const metrics = JSON.parse(metricsLine);

    expect(body).toContain('[Headings] h1: "Visible Heading"');
    expect(body).toContain('[Interactive Elements] 1 buttons, 3 links');
    expect(metrics).toEqual({
      returned_chars: body.length,
      estimated_tokens: Math.ceil(body.length / 4),
      truncated: false,
      mode: 'inspect:visible',
    });
  });
});
