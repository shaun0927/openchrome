/// <reference types="jest" />

/**
 * Tests for the default outcome contract template registry singleton
 * (A2-PR6 of #1359).
 */

import {
  getDefaultTemplateRegistry,
  resetDefaultTemplateRegistryForTests,
  PAGE_META_TEMPLATE,
  SPA_HYDRATED_TEMPLATE,
  LINK_GRAPH_TEMPLATE,
  AUTHENTICATED_FIELDS_TEMPLATE,
} from '../../../src/contracts/templates';

describe('default template registry', () => {
  beforeEach(() => {
    resetDefaultTemplateRegistryForTests();
  });

  test('lazy-initialized singleton — returns the same instance on repeat calls', () => {
    const a = getDefaultTemplateRegistry();
    const b = getDefaultTemplateRegistry();
    expect(a).toBe(b);
  });

  test('seeded with all four public-web templates', () => {
    const r = getDefaultTemplateRegistry();
    expect(r.size()).toBe(4);
    expect(r.has('public-web.page-meta')).toBe(true);
    expect(r.has('public-web.spa-hydrated')).toBe(true);
    expect(r.has('public-web.link-graph')).toBe(true);
    expect(r.has('public-web.authenticated-fields')).toBe(true);
  });

  test('lookup by id returns the exact template record', () => {
    const r = getDefaultTemplateRegistry();
    expect(r.get('public-web.page-meta')).toEqual(PAGE_META_TEMPLATE);
    expect(r.get('public-web.spa-hydrated')).toEqual(SPA_HYDRATED_TEMPLATE);
    expect(r.get('public-web.link-graph')).toEqual(LINK_GRAPH_TEMPLATE);
    expect(r.get('public-web.authenticated-fields')).toEqual(AUTHENTICATED_FIELDS_TEMPLATE);
  });

  test('lookup by id + version 1 succeeds; lookup by version 2 returns undefined', () => {
    const r = getDefaultTemplateRegistry();
    expect(r.get('public-web.page-meta', 1)).toEqual(PAGE_META_TEMPLATE);
    expect(r.get('public-web.page-meta', 2)).toBeUndefined();
  });

  test('list() returns all four ids sorted alphabetically', () => {
    const r = getDefaultTemplateRegistry();
    expect(r.list().map((e) => e.id)).toEqual([
      'public-web.authenticated-fields',
      'public-web.link-graph',
      'public-web.page-meta',
      'public-web.spa-hydrated',
    ]);
  });

  test('resetDefaultTemplateRegistryForTests rebuilds a fresh instance', () => {
    const before = getDefaultTemplateRegistry();
    resetDefaultTemplateRegistryForTests();
    const after = getDefaultTemplateRegistry();
    expect(after).not.toBe(before);
    expect(after.size()).toBe(4);
  });
});
