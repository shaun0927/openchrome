/// <reference types="jest" />

/**
 * Unit tests for pathMetaFor — additive `meta.path_taken` builder used by
 * tool result builders to surface the BrowserRouter decision (A3-PR2 of
 * #1359).
 */

import { pathMetaFor } from '../../../src/tools/_shared/path-meta';
import { BrowserBackend } from '../../../src/types/browser-backend';

function fakeManager(routing: ReturnType<any> | null) {
  return {
    getLastRouting: jest.fn(() => routing as any),
  } as any;
}

describe('pathMetaFor', () => {
  test('returns {} when targetId is undefined', () => {
    const sm = fakeManager(null);
    expect(pathMetaFor(sm, undefined)).toEqual({});
    expect(sm.getLastRouting).not.toHaveBeenCalled();
  });


  test('returns {} when a lightweight session-manager mock has no getLastRouting method', () => {
    expect(pathMetaFor({} as any, 'tab-1')).toEqual({});
  });

  test('returns {} when no routing decision is recorded', () => {
    const sm = fakeManager(null);
    expect(pathMetaFor(sm, 'tab-1')).toEqual({});
  });

  test('returns {meta:{path_taken, backend}} for a non-fallback decision', () => {
    const sm = fakeManager({
      path_taken: 'lp-served',
      backend: BrowserBackend.LIGHTPANDA,
      fallback: false,
    });
    expect(pathMetaFor(sm, 'tab-1')).toEqual({
      meta: { path_taken: 'lp-served', backend: BrowserBackend.LIGHTPANDA },
    });
  });

  test('adds fallback_reason when fallback=true', () => {
    const sm = fakeManager({
      path_taken: 'lp-unhealthy',
      backend: BrowserBackend.CHROME,
      fallback: true,
    });
    expect(pathMetaFor(sm, 'tab-1')).toEqual({
      meta: {
        path_taken: 'lp-unhealthy',
        backend: BrowserBackend.CHROME,
        fallback_reason: 'lp-unhealthy',
      },
    });
  });

  test('passes the targetId to getLastRouting', () => {
    const sm = fakeManager(null);
    pathMetaFor(sm, 'tab-xyz');
    expect(sm.getLastRouting).toHaveBeenCalledWith('tab-xyz');
  });
});
