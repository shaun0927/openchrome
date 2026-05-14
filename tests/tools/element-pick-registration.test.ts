/// <reference types="jest" />

import { createMockSessionManager } from '../utils/mock-session';

jest.mock('../../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    forceReconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(false),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { MCPServer } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';

describe('element_pick registration gate (#899)', () => {
  const originalFlag = process.env.OPENCHROME_ELEMENT_PICK;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.OPENCHROME_ELEMENT_PICK;
    } else {
      process.env.OPENCHROME_ELEMENT_PICK = originalFlag;
    }
    jest.clearAllMocks();
  });

  test('registers element_pick by default', () => {
    delete process.env.OPENCHROME_ELEMENT_PICK;
    const server = makeServer();

    registerAllTools(server);

    expect(server.getToolNames()).toContain('element_pick');
  });

  test('suppresses element_pick when OPENCHROME_ELEMENT_PICK=0', () => {
    process.env.OPENCHROME_ELEMENT_PICK = '0';
    const server = makeServer();

    registerAllTools(server);

    expect(server.getToolNames()).not.toContain('element_pick');
  });
});

function makeServer(): MCPServer {
  const mockSessionManager = createMockSessionManager();
  (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
  return new MCPServer(mockSessionManager as any);
}
