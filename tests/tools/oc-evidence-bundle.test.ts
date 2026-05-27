/// <reference types="jest" />

import type { MCPResult, ToolHandler } from '../../src/types/mcp';

const getLastRouting = jest.fn();

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getLastRouting }),
}));

function payload(result: MCPResult): any {
  return JSON.parse((result.content?.[0] as { text: string }).text);
}

async function makeHandler(): Promise<ToolHandler> {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => ({ getLastRouting }),
  }));
  const { MCPServer } = await import('../../src/mcp-server');
  const { registerOcEvidenceBundleTool } = await import('../../src/tools/oc-evidence-bundle');
  const server = new MCPServer({} as any);
  registerOcEvidenceBundleTool(server);
  return server.getToolHandler('oc_evidence_bundle')!;
}

describe('oc_evidence_bundle path metadata', () => {
  test('adds meta.path_taken when tab_id has a recorded routing decision', async () => {
    const handler = await makeHandler();
    getLastRouting.mockReturnValue({
      path_taken: 'lp-served',
      backend: 'lightpanda',
      fallback: false,
    });

    const result = await handler('session-1', {
      tab_id: 'tab-1',
      include: ['dom'],
      evidence: { snapshot: { dom: '<main>ok</main>' } },
    });

    expect(getLastRouting).toHaveBeenCalledWith('tab-1');
    expect(payload(result).meta).toEqual({
      path_taken: 'lp-served',
      backend: 'lightpanda',
    });
  });

  test('omits meta when tab_id is absent to preserve the existing response shape', async () => {
    const handler = await makeHandler();
    getLastRouting.mockReturnValue({
      path_taken: 'lp-served',
      backend: 'lightpanda',
      fallback: false,
    });

    const result = await handler('session-1', {
      include: ['dom'],
      evidence: { snapshot: { dom: '<main>ok</main>' } },
    });

    expect(getLastRouting).not.toHaveBeenCalled();
    expect(payload(result)).not.toHaveProperty('meta');
  });
});
