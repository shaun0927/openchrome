/// <reference types="jest" />

import type { Playbook } from '../../../cli/playbook/parse';
import { VarError } from '../../../cli/playbook/vars';
import {
  formatValidationResult,
  validatePlaybook,
  validationExitCode,
  type ValidateOptions,
} from '../../../cli/playbook/validate';
import type { McpToolDefinition } from '../../../cli/playbook/tool-manifest-client';

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  tool('navigate', {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false,
  }),
  tool('interact', {
    type: 'object',
    properties: { tabId: { type: 'string' }, query: { type: 'string' } },
    required: ['tabId', 'query'],
    additionalProperties: false,
  }),
  tool('act', {
    type: 'object',
    properties: { tabId: { type: 'string' }, instruction: { type: 'string' } },
    required: ['tabId', 'instruction'],
    additionalProperties: false,
  }),
  tool('fill_form', {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      fields: { type: 'object', additionalProperties: { type: 'string' } },
      refs: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['tabId'],
    additionalProperties: false,
  }),
  tool('wait_for', {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      type: { type: 'string', enum: ['navigation', 'timeout'] },
      value: { type: 'string' },
    },
    required: ['tabId', 'type'],
    additionalProperties: false,
  }),
  tool('page_screenshot', {
    type: 'object',
    properties: { tabId: { type: 'string' }, path: { type: 'string' } },
    required: ['tabId'],
    additionalProperties: false,
  }),
  tool('read_page', {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      mode: { type: 'string', enum: ['ax', 'dom', 'css', 'semantic', 'markdown'] },
    },
    required: ['tabId'],
    additionalProperties: false,
  }),
  tool('javascript_tool', {
    type: 'object',
    properties: { tabId: { type: 'string' }, code: { type: 'string' } },
    required: ['tabId'],
    additionalProperties: false,
  }),
  tool('oc_assert', {
    type: 'object',
    properties: { contract: { type: 'object', additionalProperties: true } },
    required: ['contract'],
    additionalProperties: false,
  }),
];

function tool(name: string, inputSchema: Record<string, unknown>): McpToolDefinition {
  return { name, inputSchema };
}

function makeSource(definitions: McpToolDefinition[] = TOOL_DEFINITIONS) {
  const callTool = jest.fn();
  const listToolDefinitions = jest.fn(async () => definitions);
  const source = { listToolDefinitions, callTool };
  return { source, listToolDefinitions, callTool };
}

const allVerbsPlaybook: Playbook = {
  name: 'all verbs',
  steps: [
    { verb: 'navigate', args: { url: 'https://example.com' } },
    { verb: 'interact', args: { query: 'More information' } },
    { id: 'perform_action', verb: 'act', args: { instruction: 'scroll down' } },
    { verb: 'fill_form', args: { fields: { name: 'OpenChrome' } } },
    { verb: 'wait_for', args: { type: 'navigation' } },
    { verb: 'page_screenshot', args: { path: '/tmp/page.png' } },
    { verb: 'read_page', args: { mode: 'ax' } },
    { verb: 'javascript_tool', args: { code: 'document.title' } },
    { verb: 'assert', args: { kind: 'url', pattern: 'example\\.com' } },
  ],
};

describe('validatePlaybook', () => {
  test('expands all nine verbs, reads one manifest, calls no tools, and simulates tab reuse', async () => {
    const mock = makeSource();

    const result = await validatePlaybook(allVerbsPlaybook, {
      varMap: {},
      source: mock.source as ValidateOptions['source'],
    });

    expect(result.summary).toMatchObject({ ok: true, total: 9, errors: 0 });
    expect(mock.listToolDefinitions).toHaveBeenCalledTimes(1);
    expect(mock.callTool).not.toHaveBeenCalled();
    expect(result.diagnostics.every((diagnostic) => diagnostic.instancePath !== '/tabId')).toBe(true);
  });

  test('reports tools missing from the registered manifest and preserves stable step ids', async () => {
    const mock = makeSource(TOOL_DEFINITIONS.filter((definition) => definition.name !== 'act'));

    const result = await validatePlaybook(allVerbsPlaybook, {
      varMap: {},
      source: mock.source as ValidateOptions['source'],
    });

    expect(result.summary.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepIndex: 2,
        id: 'perform_action',
        verb: 'act',
        tool: 'act',
        code: 'tool.missing',
        severity: 'error',
      }),
    ]));
  });

  test('reports an implicit tab requirement before navigation and accepts an explicit tab', async () => {
    const withoutTab = makeSource([TOOL_DEFINITIONS.find((definition) => definition.name === 'fill_form')!]);
    const firstStep: Playbook = {
      steps: [{ verb: 'fill_form', args: { fields: { name: 'OpenChrome' } } }],
    };

    const invalid = await validatePlaybook(firstStep, {
      varMap: {},
      source: withoutTab.source as ValidateOptions['source'],
    });
    expect(invalid.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'schema.required', instancePath: '/tabId' }),
    ]));

    const withTab = makeSource([TOOL_DEFINITIONS.find((definition) => definition.name === 'fill_form')!]);
    const explicitTab: Playbook = {
      steps: [{ verb: 'fill_form', args: { tabId: 'existing-tab', fields: { name: 'OpenChrome' } } }],
    };
    const valid = await validatePlaybook(explicitTab, {
      varMap: {},
      source: withTab.source as ValidateOptions['source'],
    });
    expect(valid.summary.ok).toBe(true);
  });

  test('validates schema-valued refs entries', async () => {
    const mock = makeSource([
      TOOL_DEFINITIONS.find((definition) => definition.name === 'navigate')!,
      TOOL_DEFINITIONS.find((definition) => definition.name === 'fill_form')!,
    ]);
    const playbook: Playbook = {
      steps: [
        { verb: 'navigate', args: { url: 'https://example.com' } },
        { verb: 'fill_form', args: { refs: { ref_1: 42 } } },
      ],
    };

    const result = await validatePlaybook(playbook, {
      varMap: {},
      source: mock.source as ValidateOptions['source'],
    });

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'schema.type', instancePath: '/refs/ref_1' }),
    ]));
  });

  test('substitutes variables before manifest discovery', async () => {
    const mock = makeSource();
    const playbook: Playbook = {
      steps: [{ verb: 'navigate', args: { url: '${missing}' } }],
    };

    await expect(validatePlaybook(playbook, {
      varMap: {},
      source: mock.source as ValidateOptions['source'],
    })).rejects.toThrow(VarError);

    expect(mock.listToolDefinitions).not.toHaveBeenCalled();
  });

  test('propagates registered manifest discovery failures', async () => {
    const mock = makeSource();
    mock.listToolDefinitions.mockRejectedValueOnce(new Error('manifest failed'));

    await expect(validatePlaybook(allVerbsPlaybook, {
      varMap: {},
      source: mock.source as ValidateOptions['source'],
    })).rejects.toThrow('manifest failed');
  });

  test('never exposes substituted secret values in diagnostics or formatted output', async () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const mock = makeSource([
      tool('navigate', {
        type: 'object',
        properties: { url: { type: 'string', enum: ['https://allowed.example'] } },
        required: ['url'],
        additionalProperties: false,
      }),
    ]);
    const playbook: Playbook = {
      name: 'secret check',
      steps: [{ verb: 'navigate', args: { url: '${SECRET:TOKEN}' } }],
    };

    const result = await validatePlaybook(playbook, {
      varMap: { 'SECRET:TOKEN': 'super-secret-value' },
      source: mock.source as ValidateOptions['source'],
    });

    expect(JSON.stringify(result)).not.toContain('super-secret-value');
    expect(formatValidationResult(result, false)).not.toContain('super-secret-value');
    expect(formatValidationResult(result, true)).not.toContain('super-secret-value');
    stderrSpy.mockRestore();
  });
});

describe('validation reporting', () => {
  test('formats deterministic human and JSON output and maps exit codes', async () => {
    const mock = makeSource(TOOL_DEFINITIONS.filter((definition) => definition.name !== 'act'));
    const result = await validatePlaybook(allVerbsPlaybook, {
      varMap: {},
      source: mock.source as ValidateOptions['source'],
    });

    const human = formatValidationResult(result, false);
    expect(human).toContain('SCHEMA ERRORS');
    expect(human).toContain('step 2 [perform_action]');
    expect(human).toContain('tool.missing');
    expect(formatValidationResult(result, true)).toBe(`${JSON.stringify(result, null, 2)}\n`);
    expect(validationExitCode(result)).toBe(1);

    const valid = { ...result, diagnostics: [], summary: { ...result.summary, ok: true, errors: 0, warnings: 0 } };
    expect(validationExitCode(valid)).toBe(0);
  });
});
