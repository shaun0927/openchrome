/**
 * Tab Group Manager - Manages Chrome tab groups for session isolation
 */

import { TAB_GROUP_COLORS, TabGroupColor } from './types/session';

export class TabGroupManager {
  private sessionToGroup: Map<string, number> = new Map();
  private groupToSession: Map<number, string> = new Map();
  private tabToSession: Map<number, string> = new Map();
  private colorIndex = 0;

  /**
   * Create a new tab group for a session
   */
  async createTabGroup(sessionId: string, title?: string): Promise<number> {
    // First, create a new tab to anchor the group
    const tab = await chrome.tabs.create({ active: false });
    if (!tab.id) {
      throw new Error('Failed to create tab for group');
    }

    // Create the tab group
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });

    // Set group properties
    const color = this.getNextColor();
    await chrome.tabGroups.update(groupId, {
      title: title || `Session ${sessionId.slice(0, 8)}`,
      color,
      collapsed: false,
    });

    // Store mappings
    this.sessionToGroup.set(sessionId, groupId);
    this.groupToSession.set(groupId, sessionId);
    this.tabToSession.set(tab.id, sessionId);

    return groupId;
  }

  /**
   * Add a tab to a session's group
   */
  async addTabToGroup(tabId: number, sessionId: string): Promise<void> {
    const groupId = this.sessionToGroup.get(sessionId);
    if (!groupId) {
      throw new Error(`No tab group found for session ${sessionId}`);
    }

    await chrome.tabs.group({ tabIds: [tabId], groupId });
    this.tabToSession.set(tabId, sessionId);
  }

  /**
   * Create a new tab in a session's group
   */
  async createTabInGroup(sessionId: string, url?: string): Promise<chrome.tabs.Tab> {
    const groupId = this.sessionToGroup.get(sessionId);

    // Create the tab
    const tab = await chrome.tabs.create({
      url: url || 'about:blank',
      active: true,
    });

    if (!tab.id) {
      throw new Error('Failed to create tab');
    }

    // If session has a group, add tab to it
    if (groupId) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId });
    }

    this.tabToSession.set(tab.id, sessionId);
    return tab;
  }

  /**
   * Remove a tab from its group
   */
  async removeTabFromGroup(tabId: number): Promise<void> {
    try {
      await chrome.tabs.ungroup(tabId);
    } catch {
      // Tab might already be ungrouped or closed
    }
    this.tabToSession.delete(tabId);
  }

  /**
   * Get all tabs in a session's group
   */
  async getTabsInGroup(sessionId: string): Promise<chrome.tabs.Tab[]> {
    const groupId = this.sessionToGroup.get(sessionId);
    if (!groupId) {
      return [];
    }

    return chrome.tabs.query({ groupId });
  }

  /**
   * Get tabs assigned to a session (tracked internally)
   */
  getSessionTabs(sessionId: string): number[] {
    const tabs: number[] = [];
    for (const [tabId, sid] of this.tabToSession) {
      if (sid === sessionId) {
        tabs.push(tabId);
      }
    }
    return tabs;
  }

  /**
   * Delete a tab group and close all its tabs
   */
  async deleteTabGroup(sessionId: string): Promise<void> {
    const groupId = this.sessionToGroup.get(sessionId);
    if (!groupId) {
      return;
    }

    // Get all tabs in the group
    const tabs = await chrome.tabs.query({ groupId });
    const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);

    // Remove from our tracking
    for (const tabId of tabIds) {
      this.tabToSession.delete(tabId);
    }

    // Close all tabs (which removes the group)
    if (tabIds.length > 0) {
      await chrome.tabs.remove(tabIds);
    }

    // Clean up mappings
    this.sessionToGroup.delete(sessionId);
    this.groupToSession.delete(groupId);
  }

  /**
   * Validate that a tab belongs to a session
   */
  validateTabOwnership(sessionId: string, tabId: number): boolean {
    const ownerSession = this.tabToSession.get(tabId);
    return ownerSession === sessionId;
  }

  /**
   * Get the session ID for a tab
   */
  getSessionForTab(tabId: number): string | undefined {
    return this.tabToSession.get(tabId);
  }

  /**
   * Get the tab group ID for a session
   */
  getGroupId(sessionId: string): number | undefined {
    return this.sessionToGroup.get(sessionId);
  }

  /**
   * Get the session ID for a group
   */
  getSessionForGroup(groupId: number): string | undefined {
    return this.groupToSession.get(groupId);
  }

  /**
   * Handle tab close event
   */
  onTabRemoved(tabId: number): void {
    this.tabToSession.delete(tabId);
  }

  /**
   * Handle tab group update event
   */
  onTabGroupRemoved(groupId: number): void {
    const sessionId = this.groupToSession.get(groupId);
    if (sessionId) {
      this.sessionToGroup.delete(sessionId);
      this.groupToSession.delete(groupId);
    }
  }

  /**
   * Register an existing tab group for a session
   */
  registerTabGroup(sessionId: string, groupId: number): void {
    this.sessionToGroup.set(sessionId, groupId);
    this.groupToSession.set(groupId, sessionId);
  }

  /**
   * Register an existing tab for a session
   */
  registerTab(sessionId: string, tabId: number): void {
    this.tabToSession.set(tabId, sessionId);
  }

  /**
   * Get next color in rotation
   */
  private getNextColor(): TabGroupColor {
    const color = TAB_GROUP_COLORS[this.colorIndex % TAB_GROUP_COLORS.length];
    this.colorIndex++;
    return color;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessionToGroup.keys());
  }
}
