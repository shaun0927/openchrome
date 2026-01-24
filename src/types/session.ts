/**
 * Session Types
 */

export interface Session {
  id: string;
  targets: Set<string>;  // CDP target IDs (page IDs)
  createdAt: number;
  lastActivityAt: number;
  name: string;
}

export interface SessionInfo {
  id: string;
  targetCount: number;
  createdAt: number;
  lastActivityAt: number;
  name: string;
}

export interface SessionCreateOptions {
  id?: string;
  name?: string;
}

export interface SessionEvent {
  type: 'session:created' | 'session:deleted' | 'session:target-added' | 'session:target-removed';
  sessionId: string;
  targetId?: string;
  timestamp: number;
}
