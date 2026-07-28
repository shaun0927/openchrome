/// <reference types="jest" />

import {
  ToolManifestError,
  parseRegisteredToolManifest,
} from '../../../cli/playbook/tool-manifest-client';

describe('parseRegisteredToolManifest', () => {
  test('preserves complete registered tool definitions', () => {
    expect(parseRegisteredToolManifest(JSON.stringify([
      {
        name: 'navigate',
        description: 'Navigate',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      },
    ]))).toEqual([
      {
        name: 'navigate',
        description: 'Navigate',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      },
    ]);
  });

  test('rejects invalid JSON and non-array manifests', () => {
    expect(() => parseRegisteredToolManifest('{')).toThrow(ToolManifestError);
    expect(() => parseRegisteredToolManifest('{}')).toThrow(/JSON array/);
  });

  test('rejects malformed entries instead of converting them into missing tools', () => {
    expect(() => parseRegisteredToolManifest(JSON.stringify([
      { name: 42, inputSchema: {} },
    ]))).toThrow(/entry 0 is malformed/);
  });
});
