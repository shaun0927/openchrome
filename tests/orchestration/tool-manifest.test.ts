/// <reference types="jest" />
/**
 * Tests for tool-manifest types and filterToolsForWorker function
 */

import {
  ToolEntry,
  ToolManifest,
  WorkerToolConfig,
  DEFAULT_WORKER_TOOLS,
  filterToolsForWorker,
} from '../../src/types/tool-manifest';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createMockManifest(): ToolManifest {
  return {
    version: '1',
    generatedAt: Date.now(),
    tools: [
      {
        name: 'navigate',
        description: 'Navigate to URL',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        category: 'navigation',
      },
      {
        name: 'computer',
        description: 'Browser interaction',
        inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
        category: 'interaction',
      },
      {
        name: 'read_page',
        description: 'Read page content',
        inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
        category: 'content',
      },
      {
        name: 'javascript_tool',
        description: 'Execute JS',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        category: 'javascript',
      },
      {
        name: 'click_element',
        description: 'Click element',
        inputSchema: { type: 'object', properties: { ref: { type: 'string' } } },
        category: 'composite',
      },
      {
        name: 'workflow_init',
        description: 'Init workflow',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        category: 'orchestration',
      },
      {
        name: 'worker_create',
        description: 'Create worker',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        category: 'worker',
      },
      {
        name: 'cookies',
        description: 'Manage cookies',
        inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
        category: 'network',
      },
      {
        name: 'tabs_context',
        description: 'Tab context',
        inputSchema: { type: 'object', properties: {} },
        category: 'tabs',
      },
      {
        name: 'oc_stop',
        description: 'Stop OpenChrome',
        inputSchema: { type: 'object', properties: {} },
        category: 'lifecycle',
      },
    ],
    toolCount: 10,
  };
}

// ---------------------------------------------------------------------------
// filterToolsForWorker
// ---------------------------------------------------------------------------

describe('filterToolsForWorker', () => {
  let manifest: ToolManifest;

  beforeEach(() => {
    manifest = createMockManifest();
  });

  it('should filter tools for extraction worker type', () => {
    const config: WorkerToolConfig = { workerType: 'extraction' };
    const result = filterToolsForWorker(manifest, config);

    const names = result.map(t => t.name);
    expect(names).toContain('javascript_tool'); // javascript
    expect(names).toContain('read_page');       // content
    expect(names).toContain('click_element');   // composite

    // excluded categories
    expect(names).not.toContain('navigate');      // navigation
    expect(names).not.toContain('computer');      // interaction
    expect(names).not.toContain('workflow_init'); // orchestration
    expect(names).not.toContain('worker_create'); // worker
    expect(names).not.toContain('cookies');       // network
    expect(names).not.toContain('tabs_context');  // tabs
    expect(names).not.toContain('oc_stop');      // lifecycle
  });

  it('should filter tools for interaction worker type', () => {
    const config: WorkerToolConfig = { workerType: 'interaction' };
    const result = filterToolsForWorker(manifest, config);

    const names = result.map(t => t.name);
    expect(names).toContain('navigate');        // navigation
    expect(names).toContain('computer');        // interaction
    expect(names).toContain('read_page');       // content
    expect(names).toContain('javascript_tool'); // javascript
    expect(names).toContain('click_element');   // composite

    // excluded categories
    expect(names).not.toContain('workflow_init'); // orchestration
    expect(names).not.toContain('worker_create'); // worker
    expect(names).not.toContain('cookies');       // network
    expect(names).not.toContain('tabs_context');  // tabs
    expect(names).not.toContain('oc_stop');      // lifecycle
  });

  it('should filter tools for full worker type', () => {
    const config: WorkerToolConfig = { workerType: 'full' };
    const result = filterToolsForWorker(manifest, config);

    const names = result.map(t => t.name);
    // full includes navigation, interaction, content, javascript, network, tabs, media, emulation, composite, performance
    expect(names).toContain('navigate');        // navigation
    expect(names).toContain('computer');        // interaction
    expect(names).toContain('read_page');       // content
    expect(names).toContain('javascript_tool'); // javascript
    expect(names).toContain('click_element');   // composite
    expect(names).toContain('cookies');         // network
    expect(names).toContain('tabs_context');    // tabs

    // excluded: orchestration, worker, lifecycle
    expect(names).not.toContain('workflow_init'); // orchestration
    expect(names).not.toContain('worker_create'); // worker
    expect(names).not.toContain('oc_stop');      // lifecycle
  });

  it('should include additional tools regardless of category', () => {
    // workflow_init is orchestration (excluded from extraction), but added via additionalTools
    const config: WorkerToolConfig = {
      workerType: 'extraction',
      additionalTools: ['workflow_init'],
    };
    const result = filterToolsForWorker(manifest, config);

    const names = result.map(t => t.name);
    expect(names).toContain('workflow_init');
    expect(names).toContain('javascript_tool'); // still included via category
  });

  it('should exclude specific tools even if their category matches', () => {
    const config: WorkerToolConfig = {
      workerType: 'extraction',
      excludedTools: ['javascript_tool'],
    };
    const result = filterToolsForWorker(manifest, config);

    const names = result.map(t => t.name);
    expect(names).not.toContain('javascript_tool');
    expect(names).toContain('read_page');     // still included
    expect(names).toContain('click_element'); // still included
  });

  it('should support custom allowedCategories override', () => {
    // Override to only allow network, even though workerType is extraction
    const config: WorkerToolConfig = {
      workerType: 'extraction',
      allowedCategories: ['network'],
    };
    const result = filterToolsForWorker(manifest, config);

    const names = result.map(t => t.name);
    expect(names).toContain('cookies');
    expect(names).not.toContain('javascript_tool'); // normally in extraction but overridden
    expect(names).not.toContain('read_page');
    expect(names).not.toContain('click_element');
  });

  it('should not duplicate tools when additionalTools already included by category', () => {
    // javascript_tool is already in extraction category set; also add it via additionalTools
    const config: WorkerToolConfig = {
      workerType: 'extraction',
      additionalTools: ['javascript_tool'],
    };
    const result = filterToolsForWorker(manifest, config);

    const names = result.map(t => t.name);
    const occurrences = names.filter(n => n === 'javascript_tool').length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ToolManifest structure
// ---------------------------------------------------------------------------

describe('ToolManifest', () => {
  it('should have correct structure', () => {
    const manifest: ToolManifest = {
      version: '1',
      generatedAt: Date.now(),
      tools: [],
      toolCount: 0,
    };
    expect(manifest.version).toBe('1');
    expect(manifest.toolCount).toBe(0);
    expect(Array.isArray(manifest.tools)).toBe(true);
    expect(typeof manifest.generatedAt).toBe('number');
  });

  it('should hold tool entries with all required fields', () => {
    const tool: ToolEntry = {
      name: 'navigate',
      description: 'Navigate to URL',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      category: 'navigation',
    };
    const manifest: ToolManifest = {
      version: '2',
      generatedAt: 1000,
      tools: [tool],
      toolCount: 1,
    };
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0].name).toBe('navigate');
    expect(manifest.tools[0].category).toBe('navigation');
    expect(manifest.tools[0].inputSchema.type).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_WORKER_TOOLS
// ---------------------------------------------------------------------------

describe('DEFAULT_WORKER_TOOLS', () => {
  it('extraction should include javascript, content, composite', () => {
    expect(DEFAULT_WORKER_TOOLS.extraction).toContain('javascript');
    expect(DEFAULT_WORKER_TOOLS.extraction).toContain('content');
    expect(DEFAULT_WORKER_TOOLS.extraction).toContain('composite');
  });

  it('interaction should include navigation, interaction, content, javascript, composite', () => {
    expect(DEFAULT_WORKER_TOOLS.interaction).toContain('navigation');
    expect(DEFAULT_WORKER_TOOLS.interaction).toContain('interaction');
    expect(DEFAULT_WORKER_TOOLS.interaction).toContain('content');
    expect(DEFAULT_WORKER_TOOLS.interaction).toContain('javascript');
    expect(DEFAULT_WORKER_TOOLS.interaction).toContain('composite');
  });

  it('full should include most categories', () => {
    const fullCategories = DEFAULT_WORKER_TOOLS.full;
    expect(fullCategories).toContain('navigation');
    expect(fullCategories).toContain('interaction');
    expect(fullCategories).toContain('content');
    expect(fullCategories).toContain('javascript');
    expect(fullCategories).toContain('network');
    expect(fullCategories).toContain('tabs');
    expect(fullCategories).toContain('media');
    expect(fullCategories).toContain('emulation');
    expect(fullCategories).toContain('composite');
    expect(fullCategories).toContain('performance');
  });

  it('extraction should NOT include navigation or orchestration', () => {
    expect(DEFAULT_WORKER_TOOLS.extraction).not.toContain('navigation');
    expect(DEFAULT_WORKER_TOOLS.extraction).not.toContain('orchestration');
  });
});
