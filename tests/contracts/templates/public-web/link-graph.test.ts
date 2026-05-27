/// <reference types="jest" />

/**
 * Tests for public-web.link-graph template (A2-PR4 of #1359).
 */

import {
  LINK_GRAPH_TEMPLATE,
  PAGE_META_TEMPLATE,
  SPA_HYDRATED_TEMPLATE,
  TemplateRegistry,
} from '../../../../src/contracts/templates';

describe('LINK_GRAPH_TEMPLATE — identity', () => {
  test('id is "public-web.link-graph" and version is 1', () => {
    expect(LINK_GRAPH_TEMPLATE.id).toBe('public-web.link-graph');
    expect(LINK_GRAPH_TEMPLATE.version).toBe(1);
  });

  test('description mentions site-crawl link-graph extraction', () => {
    expect(LINK_GRAPH_TEMPLATE.description.toLowerCase()).toContain('site-crawl');
    expect(LINK_GRAPH_TEMPLATE.description.toLowerCase()).toContain('link-graph');
  });

  test('tags include crawl + graph + tier-1', () => {
    expect(LINK_GRAPH_TEMPLATE.tags).toEqual(
      expect.arrayContaining(['public-web', 'crawl', 'graph', 'tier-1']),
    );
  });
});

describe('LINK_GRAPH_TEMPLATE — schema shape', () => {
  test('targetSchema.format is schema-diff.v1', () => {
    expect(LINK_GRAPH_TEMPLATE.targetSchema?.format).toBe('schema-diff.v1');
  });

  test('required fields cover identity, policy, cardinality, raw payloads', () => {
    const def = LINK_GRAPH_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string; required?: boolean }>;
    };
    const required = def.fields
      .filter((f) => f.required !== false)
      .map((f) => f.name);

    expect(required).toEqual(
      expect.arrayContaining([
        'root',
        'sameOrigin',
        'nodeCount',
        'edgeCount',
        'maxDepth',
        'nodes',
        'edges',
      ]),
    );
  });

  test('durationMs and diagnostic fields are optional', () => {
    const def = LINK_GRAPH_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; required?: boolean }>;
    };
    const optional = def.fields
      .filter((f) => f.required === false)
      .map((f) => f.name);

    expect(optional).toEqual(
      expect.arrayContaining([
        'durationMs',
        'robotsBlocked.count',
        'frontierSize.final',
      ]),
    );
  });

  test('nodes and edges are array-typed at the schema-diff level', () => {
    const def = LINK_GRAPH_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string }>;
    };
    expect(def.fields.find((f) => f.name === 'nodes')?.type).toBe('array');
    expect(def.fields.find((f) => f.name === 'edges')?.type).toBe('array');
  });

  test('sameOrigin is a boolean policy field', () => {
    const def = LINK_GRAPH_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string }>;
    };
    expect(def.fields.find((f) => f.name === 'sameOrigin')?.type).toBe('boolean');
  });

  test('every field declares a primitive JS-type bucket', () => {
    const def = LINK_GRAPH_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ type: string }>;
    };
    const allowed = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
    for (const f of def.fields) {
      expect(allowed.has(f.type)).toBe(true);
    }
  });
});

describe('LINK_GRAPH_TEMPLATE — portability and registry', () => {
  test('round-trips through JSON without loss', () => {
    const copy = JSON.parse(JSON.stringify(LINK_GRAPH_TEMPLATE));
    expect(copy).toEqual(LINK_GRAPH_TEMPLATE);
  });

  test('coexists with page-meta and spa-hydrated in the registry', () => {
    const r = new TemplateRegistry();
    r.register(PAGE_META_TEMPLATE);
    r.register(SPA_HYDRATED_TEMPLATE);
    r.register(LINK_GRAPH_TEMPLATE);

    expect(r.size()).toBe(3);
    expect(r.list().map((e) => e.id)).toEqual([
      'public-web.link-graph',
      'public-web.page-meta',
      'public-web.spa-hydrated',
    ]);
  });
});
