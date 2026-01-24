/// <reference types="jest" />
/**
 * Tests for RefIdManager
 */

import { RefIdManager, getRefIdManager } from '../extension/src/ref-id-manager';

describe('RefIdManager', () => {
  let manager: RefIdManager;

  beforeEach(() => {
    manager = new RefIdManager();
  });

  describe('generateRef', () => {
    test('should generate sequential ref IDs for a tab', () => {
      const ref1 = manager.generateRef('session-1', 1, 100, 'button', 'Submit');
      const ref2 = manager.generateRef('session-1', 1, 101, 'textbox', 'Name');
      const ref3 = manager.generateRef('session-1', 1, 102, 'link', 'Learn More');

      expect(ref1).toBe('ref_1');
      expect(ref2).toBe('ref_2');
      expect(ref3).toBe('ref_3');
    });

    test('should maintain separate counters per tab', () => {
      const ref1Tab1 = manager.generateRef('session-1', 1, 100, 'button');
      const ref1Tab2 = manager.generateRef('session-1', 2, 200, 'button');
      const ref2Tab1 = manager.generateRef('session-1', 1, 101, 'link');

      expect(ref1Tab1).toBe('ref_1');
      expect(ref1Tab2).toBe('ref_1'); // Separate counter for tab 2
      expect(ref2Tab1).toBe('ref_2');
    });

    test('should maintain separate counters per session', () => {
      const refA = manager.generateRef('session-A', 1, 100, 'button');
      const refB = manager.generateRef('session-B', 1, 200, 'button');

      expect(refA).toBe('ref_1');
      expect(refB).toBe('ref_1'); // Separate counter for session B
    });

    test('should store ref entry with all metadata', () => {
      const ref = manager.generateRef('session-1', 1, 12345, 'button', 'Click Me');

      const entry = manager.getRef('session-1', 1, ref);

      expect(entry).toBeDefined();
      expect(entry?.refId).toBe('ref_1');
      expect(entry?.backendDOMNodeId).toBe(12345);
      expect(entry?.role).toBe('button');
      expect(entry?.name).toBe('Click Me');
      expect(entry?.createdAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('getRef', () => {
    test('should return ref entry for valid ref', () => {
      manager.generateRef('session-1', 1, 100, 'button', 'Test');

      const entry = manager.getRef('session-1', 1, 'ref_1');

      expect(entry).toBeDefined();
      expect(entry?.backendDOMNodeId).toBe(100);
    });

    test('should return undefined for nonexistent ref', () => {
      const entry = manager.getRef('session-1', 1, 'ref_999');

      expect(entry).toBeUndefined();
    });

    test('should return undefined for wrong session', () => {
      manager.generateRef('session-1', 1, 100, 'button');

      const entry = manager.getRef('session-2', 1, 'ref_1');

      expect(entry).toBeUndefined();
    });

    test('should return undefined for wrong tab', () => {
      manager.generateRef('session-1', 1, 100, 'button');

      const entry = manager.getRef('session-1', 2, 'ref_1');

      expect(entry).toBeUndefined();
    });
  });

  describe('getBackendDOMNodeId', () => {
    test('should return backendDOMNodeId for valid ref', () => {
      manager.generateRef('session-1', 1, 42, 'button');

      const nodeId = manager.getBackendDOMNodeId('session-1', 1, 'ref_1');

      expect(nodeId).toBe(42);
    });

    test('should return undefined for invalid ref', () => {
      const nodeId = manager.getBackendDOMNodeId('session-1', 1, 'ref_999');

      expect(nodeId).toBeUndefined();
    });
  });

  describe('clearTabRefs', () => {
    test('should clear all refs for a tab', () => {
      manager.generateRef('session-1', 1, 100, 'button');
      manager.generateRef('session-1', 1, 101, 'link');

      manager.clearTabRefs('session-1', 1);

      expect(manager.getRef('session-1', 1, 'ref_1')).toBeUndefined();
      expect(manager.getRef('session-1', 1, 'ref_2')).toBeUndefined();
    });

    test('should reset counter for tab', () => {
      manager.generateRef('session-1', 1, 100, 'button');
      manager.generateRef('session-1', 1, 101, 'link');

      manager.clearTabRefs('session-1', 1);

      const newRef = manager.generateRef('session-1', 1, 200, 'button');
      expect(newRef).toBe('ref_1'); // Counter reset
    });

    test('should not affect other tabs', () => {
      manager.generateRef('session-1', 1, 100, 'button');
      manager.generateRef('session-1', 2, 200, 'link');

      manager.clearTabRefs('session-1', 1);

      expect(manager.getRef('session-1', 2, 'ref_1')).toBeDefined();
    });

    test('should handle clearing nonexistent tab', () => {
      expect(() => manager.clearTabRefs('session-1', 999)).not.toThrow();
    });
  });

  describe('clearSessionRefs', () => {
    test('should clear all refs for a session', () => {
      manager.generateRef('session-1', 1, 100, 'button');
      manager.generateRef('session-1', 2, 200, 'link');

      manager.clearSessionRefs('session-1');

      expect(manager.getRef('session-1', 1, 'ref_1')).toBeUndefined();
      expect(manager.getRef('session-1', 2, 'ref_1')).toBeUndefined();
    });

    test('should not affect other sessions', () => {
      manager.generateRef('session-1', 1, 100, 'button');
      manager.generateRef('session-2', 1, 200, 'link');

      manager.clearSessionRefs('session-1');

      expect(manager.getRef('session-2', 1, 'ref_1')).toBeDefined();
    });
  });

  describe('getTabRefs', () => {
    test('should return all refs for a tab', () => {
      manager.generateRef('session-1', 1, 100, 'button', 'Submit');
      manager.generateRef('session-1', 1, 101, 'link', 'More');
      manager.generateRef('session-1', 1, 102, 'textbox', 'Email');

      const refs = manager.getTabRefs('session-1', 1);

      expect(refs).toHaveLength(3);
      expect(refs.map((r) => r.role)).toContain('button');
      expect(refs.map((r) => r.role)).toContain('link');
      expect(refs.map((r) => r.role)).toContain('textbox');
    });

    test('should return empty array for nonexistent tab', () => {
      const refs = manager.getTabRefs('session-1', 999);

      expect(refs).toEqual([]);
    });
  });

  describe('getStats', () => {
    test('should return accurate stats', () => {
      manager.generateRef('session-1', 1, 100, 'button');
      manager.generateRef('session-1', 1, 101, 'link');
      manager.generateRef('session-1', 2, 200, 'textbox');
      manager.generateRef('session-2', 1, 300, 'checkbox');

      const stats = manager.getStats();

      expect(stats.sessions).toBe(2);
      expect(stats.totalRefs).toBe(4);
    });

    test('should return zeros for empty manager', () => {
      const stats = manager.getStats();

      expect(stats.sessions).toBe(0);
      expect(stats.totalRefs).toBe(0);
    });
  });
});

describe('getRefIdManager (singleton)', () => {
  test('should return the same instance', () => {
    const instance1 = getRefIdManager();
    const instance2 = getRefIdManager();

    expect(instance1).toBe(instance2);
  });
});
