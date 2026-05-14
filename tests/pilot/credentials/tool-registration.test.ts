import { MCPServer } from '../../../src/mcp-server';
import { registerAllTools } from '../../../src/tools';
import { resetFlagsCache } from '../../../src/harness/flags';

describe('oc_credentials pilot registration', () => {
  const oldPilot = process.env.OPENCHROME_PILOT;
  afterEach(() => {
    if (oldPilot === undefined) delete process.env.OPENCHROME_PILOT; else process.env.OPENCHROME_PILOT = oldPilot;
    resetFlagsCache();
  });

  test('is absent without pilot and present with pilot', () => {
    delete process.env.OPENCHROME_PILOT;
    resetFlagsCache();
    const core = new MCPServer();
    registerAllTools(core);
    expect(core.getToolNames()).not.toContain('oc_credentials');

    process.env.OPENCHROME_PILOT = '1';
    resetFlagsCache();
    const pilot = new MCPServer();
    registerAllTools(pilot);
    expect(pilot.getToolNames()).toContain('oc_credentials');
  });
});
