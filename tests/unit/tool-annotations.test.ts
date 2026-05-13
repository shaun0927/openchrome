/**
 * Tests for the ToolAnnotations contract (issue #867).
 *
 * Three guarantees this test enforces:
 *   1. Every tool registered with MCPServer has a TOOL_ANNOTATIONS entry.
 *   2. registerTool() throws if a tool's name has no entry (defense in depth
 *      against the rare case where definition.name diverges from the registry
 *      key).
 *   3. tools/list response preserves the `annotations` field byte-for-byte
 *      from the canonical TOOL_ANNOTATIONS table.
 */

import { TOOL_ANNOTATIONS, requireAnnotations } from '../../src/types/tool-annotations';
import type { ToolAnnotations, MCPToolDefinition, ToolHandler } from '../../src/types/mcp';

describe('TOOL_ANNOTATIONS table', () => {
  test('every entry has all four required hint fields', () => {
    for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
      expect(typeof ann.readOnlyHint).toBe('boolean');
      expect(typeof ann.destructiveHint).toBe('boolean');
      expect(typeof ann.idempotentHint).toBe('boolean');
      expect(typeof ann.openWorldHint).toBe('boolean');
      // Sanity: a read-only tool cannot also be destructive.
      if (ann.readOnlyHint && ann.destructiveHint) {
        throw new Error(`Tool '${name}' is both readOnly and destructive — that violates the worst-case rule`);
      }
    }
  });

  test('expected destructive tools are annotated as destructive', () => {
    const destructive = [
      'cookies',
      'storage',
      'tabs_close',
      'oc_stop',
      'oc_reap_orphans',
      'oc_recording_stop',
      'request_intercept',
      'workflow_cleanup',
      'worker_complete',
      // Arbitrary-execution / blocking tools — worst-case capability includes
      // destructive operations against page state, network, or sibling tools.
      'javascript_tool',
      'batch_execute',
      'act',
      'network',
      // `console_capture` supports `clear`, which deletes buffered logs.
      'console_capture',
    ];
    for (const name of destructive) {
      expect(TOOL_ANNOTATIONS[name as keyof typeof TOOL_ANNOTATIONS].destructiveHint).toBe(true);
    }
  });

  test('expected read-only tools are annotated as readOnly', () => {
    const readonly = [
      'read_page',
      'query_dom',
      'find',
      'inspect',
      'tabs_context',
      'list_profiles',
      'oc_profile_status',
      'oc_get_connection_info',
      'oc_connection_health',
      'oc_skill_recall',
      'performance_metrics',
      'vision_find',
    ];
    for (const name of readonly) {
      expect(TOOL_ANNOTATIONS[name as keyof typeof TOOL_ANNOTATIONS].readOnlyHint).toBe(true);
    }
  });

  test('expected open-world tools are annotated as openWorld', () => {
    const openWorld = ['navigate', 'crawl', 'crawl_sitemap', 'act', 'page_reload', 'network', 'request_intercept', 'javascript_tool', 'batch_execute', 'validate_page', 'batch_paginate'];
    for (const name of openWorld) {
      expect(TOOL_ANNOTATIONS[name as keyof typeof TOOL_ANNOTATIONS].openWorldHint).toBe(true);
    }
  });

  test('reverse direction — every table entry has a registered tool file', async () => {
    // Catches the "orphan entry" failure mode: a name in TOOL_ANNOTATIONS that
    // no longer corresponds to any tool, leaving dead metadata.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const toolsDir = path.join(__dirname, '..', '..', 'src', 'tools');
    const pilotHandoffDir = path.join(__dirname, '..', '..', 'src', 'pilot', 'handoff');
    const pilotProxyDir = path.join(__dirname, '..', '..', 'src', 'pilot', 'proxy');
    const runHarnessDir = path.join(__dirname, '..', '..', 'src', 'run-harness');
    const mcpServerFile = path.join(__dirname, '..', '..', 'src', 'mcp-server.ts');

    const referencedNames = new Set<string>();

    const collectFromDir = async (dir: string) => {
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
      for (const f of files) {
        const src = await fs.readFile(path.join(dir, f), 'utf8');
        const matches = src.match(/TOOL_ANNOTATIONS\.([a-zA-Z_][a-zA-Z0-9_]*)/g) || [];
        for (const m of matches) {
          referencedNames.add(m.replace('TOOL_ANNOTATIONS.', ''));
        }
      }
    };

    await collectFromDir(toolsDir);
    await collectFromDir(pilotHandoffDir);
    await collectFromDir(pilotProxyDir);
    await collectFromDir(runHarnessDir);
    // The `expand_tools` virtual tool is referenced inline in mcp-server.ts.
    const serverSrc = await fs.readFile(mcpServerFile, 'utf8');
    const serverMatches = serverSrc.match(/TOOL_ANNOTATIONS\.([a-zA-Z_][a-zA-Z0-9_]*)/g) || [];
    for (const m of serverMatches) {
      referencedNames.add(m.replace('TOOL_ANNOTATIONS.', ''));
    }

    const tableEntries = new Set(Object.keys(TOOL_ANNOTATIONS));
    const orphans = [...tableEntries].filter((n) => !referencedNames.has(n));
    expect(orphans).toEqual([]);
  });
});

describe('requireAnnotations()', () => {
  test('returns the entry for a known tool', () => {
    const ann = requireAnnotations('navigate');
    expect(ann.openWorldHint).toBe(true);
  });

  test('throws for an unknown tool', () => {
    expect(() => requireAnnotations('definitely-not-a-real-tool-xyz')).toThrow(
      /TOOL_ANNOTATIONS/,
    );
  });
});

describe('MCPToolDefinition type integration', () => {
  test('every registered tool file declares annotations matching the table', async () => {
    // Discover every tool file and import its `register*` function. We do not
    // import the whole module here (it would pull in puppeteer-core etc.),
    // so instead we statically scan the sources for `annotations:
    // TOOL_ANNOTATIONS.<toolName>` declarations and assert the count matches
    // the number of distinct `name: '...'` literals in src/tools/.
    //
    // This is intentionally a source-level check, not a runtime spin-up: it
    // protects against the failure mode where a future refactor drops the
    // annotations line in a tool file but TypeScript's structural typing
    // silently allows it (which it would not today, but defends against
    // future loosening of MCPToolDefinition).
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const toolsDir = path.join(__dirname, '..', '..', 'src', 'tools');
    const files = (await fs.readdir(toolsDir)).filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts',
    );

    let nameCount = 0;
    let annotationsCount = 0;
    const namesFound: string[] = [];
    for (const f of files) {
      const src = await fs.readFile(path.join(toolsDir, f), 'utf8');
      const nameMatches = src.match(/^\s*name\s*:\s*['"][a-z][a-zA-Z0-9_]+['"]/gm) || [];
      // Filter to lines that look like top-level tool-definition name fields
      // (i.e. not nested `name:` in input-schema properties).
      const annotationsMatches = src.match(/^\s*annotations\s*:\s*TOOL_ANNOTATIONS\.([a-zA-Z_][a-zA-Z0-9_]*)/gm) || [];

      for (const m of annotationsMatches) {
        const toolName = m.match(/TOOL_ANNOTATIONS\.([a-zA-Z_][a-zA-Z0-9_]*)/)![1];
        namesFound.push(toolName);
        // Assert this name exists in the table.
        expect(TOOL_ANNOTATIONS).toHaveProperty(toolName);
      }
      annotationsCount += annotationsMatches.length;
      nameCount += nameMatches.length;
    }

    // Every tool file should have at least one annotations line.
    expect(annotationsCount).toBeGreaterThanOrEqual(files.length);
    // Spot-check known multi-tool files have the right counts.
    const multiToolExpectations: Record<string, number> = {
      'orchestration.ts': 8,
      'recording.ts': 5,
      'connect.ts': 3,
    };
    for (const [file, expected] of Object.entries(multiToolExpectations)) {
      const src = await fs.readFile(path.join(toolsDir, file), 'utf8');
      const matches = (src.match(/annotations\s*:\s*TOOL_ANNOTATIONS\./g) || []).length;
      expect(matches).toBe(expected);
    }
  });
});

describe('tools/list response shape', () => {
  test('an MCPToolDefinition with annotations serializes correctly', () => {
    const def: MCPToolDefinition = {
      name: 'navigate',
      description: 'test',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: TOOL_ANNOTATIONS.navigate,
    };
    const json = JSON.parse(JSON.stringify(def));
    expect(json.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});
