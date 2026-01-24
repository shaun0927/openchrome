/**
 * Session types for parallel Claude Code sessions
 */

export interface Session {
  /** Unique session identifier (UUID) */
  id: string;

  /** Chrome tab group ID for this session (-1 if not yet created) */
  tabGroupId: number;

  /** Set of tab IDs belonging to this session */
  tabs: Set<number>;

  /** Map of tab ID to CDP debugger target */
  cdpConnections: Map<number, chrome.debugger.Debuggee>;

  /** Timestamp when session was created */
  createdAt: number;

  /** Timestamp of last activity */
  lastActivityAt: number;

  /** Session display name (for tab group) */
  name: string;

  /** Color for the tab group */
  color: chrome.tabGroups.ColorEnum;
}

export interface SessionCreateOptions {
  /** Session ID (if not provided, will be generated) */
  id?: string;

  /** Display name for the session */
  name?: string;

  /** Color for the tab group */
  color?: chrome.tabGroups.ColorEnum;
}

export interface SessionInfo {
  id: string;
  tabGroupId: number;
  tabCount: number;
  createdAt: number;
  lastActivityAt: number;
  name: string;
}

export type SessionEventType =
  | 'session:created'
  | 'session:deleted'
  | 'session:tab-added'
  | 'session:tab-removed'
  | 'session:cdp-attached'
  | 'session:cdp-detached';

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  tabId?: number;
  timestamp: number;
}

/** Tab group colors available in Chrome */
export const TAB_GROUP_COLORS: chrome.tabGroups.ColorEnum[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
];
