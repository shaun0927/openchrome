import { MCPServer } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';

describe('Handoff tool registration', () => {
  it('registers secret-safe handoff tools', () => {
    const server = new MCPServer(undefined as any);
    registerAllTools(server);
    const names = server.getToolNames();
    expect(names).toEqual(expect.arrayContaining([
      'oc_handoff_start',
      'oc_handoff_status',
      'oc_handoff_finish',
      'oc_handoff_cancel',
    ]));
  });
});
