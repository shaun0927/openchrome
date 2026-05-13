import { registerOcPilotRunWithRecoveryTool } from '../../src/tools/oc-pilot-run-with-recovery';
import type { MCPResult, ToolHandler } from '../../src/types/mcp';

function result(text: string, isError = false): MCPResult {
  return { content: [{ type: 'text', text }], isError };
}

function makeServer(handlers: Record<string, ToolHandler>) {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool: (_name: string, handler: ToolHandler) => tools.set(_name, handler),
    getToolHandler: (name: string) => tools.get(name) || handlers[name] || null,
    call: async (args: Record<string, unknown>) => tools.get('oc_pilot_run_with_recovery')!('session', args),
  };
}

function parse(result: MCPResult): Record<string, any> {
  return JSON.parse(result.content?.[0]?.text || '{}');
}

describe('oc_pilot_run_with_recovery', () => {
  it('dryRun proposes safe recipes without executing the original action', async () => {
    const original = jest.fn(async () => result('should not run'));
    const server = makeServer({ interact: original });
    registerOcPilotRunWithRecoveryTool(server as any);

    const out = parse(await server.call({
      dryRun: true,
      action: { tool: 'interact', arguments: { query: 'Submit' } },
      allowedRecipes: ['refresh_dom_state', 'wait_for_page_ready'],
      maxRecoveryAttempts: 2,
    }));

    expect(out.status).toBe('dry_run');
    expect(out.recovery.map((entry: any) => entry.recipe)).toEqual(['refresh_dom_state', 'wait_for_page_ready']);
    expect(original).not.toHaveBeenCalled();
  });

  it('recovers known stale element failures with refresh_dom_state evidence', async () => {
    const server = makeServer({
      interact: jest.fn(async () => result('STALE_REF: element not found', true)),
      read_page: jest.fn(async () => result('fresh dom')),
    });
    registerOcPilotRunWithRecoveryTool(server as any);

    const response = await server.call({
      tabId: 'tab-1',
      action: { tool: 'interact', arguments: { query: 'Submit' } },
      allowedRecipes: ['refresh_dom_state'],
      maxRecoveryAttempts: 1,
    });
    const out = parse(response);

    expect(out.status).toBe('recovered');
    expect(out.recovery[0]).toMatchObject({ recipe: 'refresh_dom_state', reason: 'stale_or_missing_element' });
    expect(out.recovery[0].actions[0]).toMatchObject({ tool: 'read_page', ok: true });
  });

  it('rejects unsafe tools and hard bound violations', async () => {
    const server = makeServer({});
    registerOcPilotRunWithRecoveryTool(server as any);

    const unsafe = await server.call({ action: { tool: 'cookies', arguments: {} } });
    expect(unsafe.isError).toBe(true);
    expect(unsafe.content?.[0]?.text).toContain('UNSAFE_ACTION');

    const tooMany = await server.call({ action: { tool: 'interact', arguments: {} }, maxRecoveryAttempts: 99 });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content?.[0]?.text).toContain('maxRecoveryAttempts must be <= 3');
  });

  it('does not attempt recovery for unknown failure classes', async () => {
    const server = makeServer({ interact: jest.fn(async () => result('unclassified failure', true)) });
    registerOcPilotRunWithRecoveryTool(server as any);

    const response = await server.call({ action: { tool: 'interact', arguments: { query: 'Submit' } } });
    const out = parse(response);

    expect(response.isError).toBe(true);
    expect(out.status).toBe('failed');
    expect(out.recovery).toEqual([]);
  });
});

describe('oc_pilot_run_with_recovery registration gate', () => {
  const originalPilot = process.env.OPENCHROME_PILOT;
  const originalRuntime = process.env.OPENCHROME_CONTRACT_RUNTIME;

  afterEach(() => {
    if (originalPilot === undefined) delete process.env.OPENCHROME_PILOT;
    else process.env.OPENCHROME_PILOT = originalPilot;
    if (originalRuntime === undefined) delete process.env.OPENCHROME_CONTRACT_RUNTIME;
    else process.env.OPENCHROME_CONTRACT_RUNTIME = originalRuntime;
    jest.resetModules();
  });

  it('is absent by default and present only when pilot contract runtime is enabled', async () => {
    let mod = await import('../../src/harness/flags');
    mod.resetFlagsCache();
    let tools = await import('../../src/tools');
    let { MCPServer } = await import('../../src/mcp-server');
    let server = new MCPServer(undefined as any);
    tools.registerAllTools(server);
    expect(server.getToolNames()).not.toContain('oc_pilot_run_with_recovery');

    jest.resetModules();
    process.env.OPENCHROME_PILOT = '1';
    process.env.OPENCHROME_CONTRACT_RUNTIME = '1';
    mod = await import('../../src/harness/flags');
    mod.resetFlagsCache();
    tools = await import('../../src/tools');
    ({ MCPServer } = await import('../../src/mcp-server'));
    server = new MCPServer(undefined as any);
    tools.registerAllTools(server);
    expect(server.getToolNames()).toContain('oc_pilot_run_with_recovery');
  });
});
