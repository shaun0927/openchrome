/// <reference types="jest" />

describe('manifest-only tool registration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('collects definitions without constructing the runtime session manager', () => {
    jest.resetModules();
    const sessionManager = require('../../src/session-manager') as typeof import('../../src/session-manager');
    const getSessionManager = jest.spyOn(sessionManager, 'getSessionManager')
      .mockImplementation(() => {
        throw new Error('manifest registration must not construct runtime services');
      });
    const { MCPServer } = require('../../src/mcp-server') as typeof import('../../src/mcp-server');
    const { registerAllTools } = require('../../src/tools') as typeof import('../../src/tools');

    const server = new MCPServer(undefined, { initialToolTier: 3, manifestOnly: true });

    expect(() => registerAllTools(server, { runtimeSideEffects: false })).not.toThrow();
    expect(getSessionManager).not.toHaveBeenCalled();
    expect(server.getToolNames()).toContain('navigate');
  });
});
