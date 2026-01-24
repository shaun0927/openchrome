/// <reference types="jest" />
/// <reference types="chrome" />
/**
 * Tests for TabGroupManager
 */

import { TabGroupManager } from '../extension/src/tab-group-manager';

describe('TabGroupManager', () => {
  let manager: TabGroupManager;

  beforeEach(() => {
    manager = new TabGroupManager();

    // Mock Chrome APIs
    (chrome.tabs.create as jest.Mock).mockResolvedValue({ id: 1 });
    (chrome.tabs.group as jest.Mock).mockResolvedValue(100);
    (chrome.tabGroups.update as jest.Mock).mockResolvedValue({});
    (chrome.tabs.query as jest.Mock).mockResolvedValue([]);
    (chrome.tabs.ungroup as jest.Mock).mockResolvedValue(undefined);
    (chrome.tabs.remove as jest.Mock).mockResolvedValue(undefined);
  });

  describe('createTabGroup', () => {
    test('should create a new tab group and return the group ID', async () => {
      const groupId = await manager.createTabGroup('session-1', 'Test Group');

      expect(chrome.tabs.create).toHaveBeenCalledWith({ active: false });
      expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1] });
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(100, {
        title: 'Test Group',
        color: expect.any(String),
        collapsed: false,
      });
      expect(groupId).toBe(100);
    });

    test('should use default title when not provided', async () => {
      await manager.createTabGroup('session-abc123');

      expect(chrome.tabGroups.update).toHaveBeenCalledWith(100, {
        title: 'Session session-',  // First 8 chars of 'session-abc123'
        color: expect.any(String),
        collapsed: false,
      });
    });

    test('should store session-to-group mapping', async () => {
      await manager.createTabGroup('session-1');

      expect(manager.getGroupId('session-1')).toBe(100);
    });

    test('should store group-to-session mapping', async () => {
      await manager.createTabGroup('session-1');

      expect(manager.getSessionForGroup(100)).toBe('session-1');
    });

    test('should track the initial tab', async () => {
      await manager.createTabGroup('session-1');

      expect(manager.validateTabOwnership('session-1', 1)).toBe(true);
    });

    test('should assign colors in rotation', async () => {
      // Create multiple groups
      (chrome.tabs.group as jest.Mock)
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(101)
        .mockResolvedValueOnce(102);
      (chrome.tabs.create as jest.Mock)
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 })
        .mockResolvedValueOnce({ id: 3 });

      await manager.createTabGroup('session-1');
      await manager.createTabGroup('session-2');
      await manager.createTabGroup('session-3');

      // Each should have been called with a color
      expect(chrome.tabGroups.update).toHaveBeenCalledTimes(3);
    });
  });

  describe('addTabToGroup', () => {
    test('should add a tab to the session group', async () => {
      await manager.createTabGroup('session-1');

      await manager.addTabToGroup(5, 'session-1');

      expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [5], groupId: 100 });
      expect(manager.validateTabOwnership('session-1', 5)).toBe(true);
    });

    test('should throw error if session has no group', async () => {
      await expect(manager.addTabToGroup(5, 'nonexistent'))
        .rejects.toThrow('No tab group found for session nonexistent');
    });
  });

  describe('createTabInGroup', () => {
    test('should create a tab in the session group', async () => {
      await manager.createTabGroup('session-1');
      (chrome.tabs.create as jest.Mock).mockResolvedValueOnce({ id: 10 });

      const tab = await manager.createTabInGroup('session-1', 'https://example.com');

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'https://example.com',
        active: true,
      });
      expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [10], groupId: 100 });
      expect(tab.id).toBe(10);
      expect(manager.validateTabOwnership('session-1', 10)).toBe(true);
    });

    test('should create a blank tab if no URL provided', async () => {
      await manager.createTabGroup('session-1');
      (chrome.tabs.create as jest.Mock).mockResolvedValueOnce({ id: 10 });

      await manager.createTabInGroup('session-1');

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'about:blank',
        active: true,
      });
    });
  });

  describe('validateTabOwnership', () => {
    test('should return true for owned tab', async () => {
      await manager.createTabGroup('session-1');

      expect(manager.validateTabOwnership('session-1', 1)).toBe(true);
    });

    test('should return false for unowned tab', async () => {
      await manager.createTabGroup('session-1');

      expect(manager.validateTabOwnership('session-1', 999)).toBe(false);
    });

    test('should return false for tab owned by different session', async () => {
      (chrome.tabs.create as jest.Mock)
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 });
      (chrome.tabs.group as jest.Mock)
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(101);

      await manager.createTabGroup('session-1');
      await manager.createTabGroup('session-2');

      expect(manager.validateTabOwnership('session-1', 2)).toBe(false);
      expect(manager.validateTabOwnership('session-2', 1)).toBe(false);
    });
  });

  describe('getTabsInGroup', () => {
    test('should return tabs in the session group', async () => {
      await manager.createTabGroup('session-1');
      (chrome.tabs.query as jest.Mock).mockResolvedValue([
        { id: 1, url: 'about:blank' },
        { id: 5, url: 'https://example.com' },
      ]);

      const tabs = await manager.getTabsInGroup('session-1');

      expect(chrome.tabs.query).toHaveBeenCalledWith({ groupId: 100 });
      expect(tabs).toHaveLength(2);
    });

    test('should return empty array for nonexistent session', async () => {
      const tabs = await manager.getTabsInGroup('nonexistent');

      expect(tabs).toEqual([]);
    });
  });

  describe('getSessionTabs', () => {
    test('should return tracked tab IDs for a session', async () => {
      await manager.createTabGroup('session-1');
      (chrome.tabs.create as jest.Mock).mockResolvedValueOnce({ id: 5 });
      await manager.createTabInGroup('session-1');

      const tabIds = manager.getSessionTabs('session-1');

      expect(tabIds).toContain(1);
      expect(tabIds).toContain(5);
    });
  });

  describe('removeTabFromGroup', () => {
    test('should ungroup a tab and remove tracking', async () => {
      await manager.createTabGroup('session-1');

      await manager.removeTabFromGroup(1);

      expect(chrome.tabs.ungroup).toHaveBeenCalledWith(1);
      expect(manager.validateTabOwnership('session-1', 1)).toBe(false);
    });

    test('should handle already ungrouped tabs gracefully', async () => {
      (chrome.tabs.ungroup as jest.Mock).mockRejectedValue(new Error('Tab not in group'));

      await expect(manager.removeTabFromGroup(999)).resolves.not.toThrow();
    });
  });

  describe('deleteTabGroup', () => {
    test('should close all tabs in the group', async () => {
      await manager.createTabGroup('session-1');
      (chrome.tabs.query as jest.Mock).mockResolvedValue([
        { id: 1 },
        { id: 5 },
      ]);

      await manager.deleteTabGroup('session-1');

      expect(chrome.tabs.remove).toHaveBeenCalledWith([1, 5]);
    });

    test('should clean up mappings', async () => {
      await manager.createTabGroup('session-1');
      (chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 1 }]);

      await manager.deleteTabGroup('session-1');

      expect(manager.getGroupId('session-1')).toBeUndefined();
      expect(manager.getSessionForGroup(100)).toBeUndefined();
      expect(manager.validateTabOwnership('session-1', 1)).toBe(false);
    });

    test('should handle nonexistent session gracefully', async () => {
      await expect(manager.deleteTabGroup('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('onTabRemoved', () => {
    test('should remove tab from tracking', async () => {
      await manager.createTabGroup('session-1');

      manager.onTabRemoved(1);

      expect(manager.validateTabOwnership('session-1', 1)).toBe(false);
    });
  });

  describe('onTabGroupRemoved', () => {
    test('should clean up session-group mappings', async () => {
      await manager.createTabGroup('session-1');

      manager.onTabGroupRemoved(100);

      expect(manager.getGroupId('session-1')).toBeUndefined();
      expect(manager.getSessionForGroup(100)).toBeUndefined();
    });
  });

  describe('registerTabGroup', () => {
    test('should register an existing group for a session', () => {
      manager.registerTabGroup('session-1', 200);

      expect(manager.getGroupId('session-1')).toBe(200);
      expect(manager.getSessionForGroup(200)).toBe('session-1');
    });
  });

  describe('registerTab', () => {
    test('should register an existing tab for a session', () => {
      manager.registerTab('session-1', 10);

      expect(manager.validateTabOwnership('session-1', 10)).toBe(true);
    });
  });

  describe('getActiveSessions', () => {
    test('should return all sessions with tab groups', async () => {
      (chrome.tabs.create as jest.Mock)
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 });
      (chrome.tabs.group as jest.Mock)
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(101);

      await manager.createTabGroup('session-1');
      await manager.createTabGroup('session-2');

      const sessions = manager.getActiveSessions();

      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
      expect(sessions).toHaveLength(2);
    });
  });

  describe('concurrent operations', () => {
    test('should handle multiple simultaneous group creations', async () => {
      let tabIdCounter = 1;
      let groupIdCounter = 100;

      (chrome.tabs.create as jest.Mock).mockImplementation(async () => ({ id: tabIdCounter++ }));
      (chrome.tabs.group as jest.Mock).mockImplementation(async () => groupIdCounter++);

      const promises = [
        manager.createTabGroup('session-1'),
        manager.createTabGroup('session-2'),
        manager.createTabGroup('session-3'),
      ];

      const groupIds = await Promise.all(promises);

      expect(groupIds).toEqual([100, 101, 102]);
      expect(manager.getActiveSessions()).toHaveLength(3);
    });
  });
});
