/// <reference types="jest" />
/**
 * Tests for oc_reap_orphans tool
 */

import { createMockSessionManager } from '../utils/mock-session';

const mockCleanOrphanedChromeProcesses = jest.fn();

jest.mock('../../src/utils/pid-manager', () => ({
  cleanOrphanedChromeProcesses: mockCleanOrphanedChromeProcesses,
}));

import { MCPServer } from '../../src/mcp-server';
import { setGlobalConfig } from '../../src/config/global';
import { registerReapOrphansTool } from '../../src/tools/reap-orphans';

describe('oc_reap_orphans tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;
  const originalChromePort = process.env.CHROME_PORT;
  const originalOpenChromeCdpPort = process.env.OPENCHROME_CDP_PORT;

  beforeEach(() => {
    delete process.env.CHROME_PORT;
    delete process.env.OPENCHROME_CDP_PORT;
    setGlobalConfig({ port: 9222 });
    mockCleanOrphanedChromeProcesses.mockReturnValue(0);

    const mockSessionManager = createMockSessionManager();
    server = new MCPServer(mockSessionManager as any);
    registerReapOrphansTool(server);
    handler = server.getToolHandler('oc_reap_orphans')!;
    expect(handler).toBeDefined();
  });

  afterEach(() => {
    if (originalChromePort === undefined) delete process.env.CHROME_PORT;
    else process.env.CHROME_PORT = originalChromePort;
    if (originalOpenChromeCdpPort === undefined) delete process.env.OPENCHROME_CDP_PORT;
    else process.env.OPENCHROME_CDP_PORT = originalOpenChromeCdpPort;
    setGlobalConfig({ port: 9222 });
    jest.clearAllMocks();
  });

  test('uses the active global CDP port window when ports are omitted', async () => {
    setGlobalConfig({ port: 9333 });

    const result = await handler('broken-session', {});
    const data = JSON.parse(result.content[0].text);

    expect(mockCleanOrphanedChromeProcesses).toHaveBeenCalledWith([9333, 9334, 9335, 9336, 9337]);
    expect(data.checkedPorts).toEqual([9333, 9334, 9335, 9336, 9337]);
  });

  test('keeps runtime config precedence over stale CDP port environment variables', async () => {
    process.env.OPENCHROME_CDP_PORT = '9444';
    setGlobalConfig({ port: 9222 });

    const result = await handler('broken-session', {});
    const data = JSON.parse(result.content[0].text);

    expect(mockCleanOrphanedChromeProcesses).toHaveBeenCalledWith([9222, 9223, 9224, 9225, 9226]);
    expect(data.checkedPorts).toEqual([9222, 9223, 9224, 9225, 9226]);
  });

  test('deduplicates explicit ports and preserves explicit override semantics', async () => {
    await handler('broken-session', { ports: [9555, '9556', 9555, 0, 70000, 'bad'] });

    expect(mockCleanOrphanedChromeProcesses).toHaveBeenCalledWith([9555, 9556]);
  });
});
