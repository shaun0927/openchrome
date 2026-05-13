import { MCPServer } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';

describe('TaskRun tool registration', () => {
  it('registers all goal-level TaskRun tools', () => {
    const server = new MCPServer(undefined as any);
    registerAllTools(server);
    const names = server.getToolNames();
    expect(names).toEqual(expect.arrayContaining([
      'oc_task_run_start',
      'oc_task_run_update',
      'oc_task_run_checkpoint',
      'oc_task_run_needs_help',
      'oc_task_run_complete',
      'oc_task_run_get',
      'oc_task_run_list',
    ]));
  });
});

describe('TaskRun checkpoint tool schema', () => {
  it('accepts include_checkpoint on oc_task_run_get', () => {
    const server = new MCPServer(undefined as any);
    registerAllTools(server);
    const definition = server.getToolManifest().tools.find(tool => tool.name === 'oc_task_run_get');
    expect(definition).toBeDefined();
    expect(definition?.inputSchema.properties.include_checkpoint).toBeDefined();
  });
});
