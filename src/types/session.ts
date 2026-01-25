/**
 * Session Types
 */

import { BrowserContext } from 'puppeteer-core';

/**
 * Worker - An isolated browser context within a session
 * Each worker has its own cookies, localStorage, sessionStorage
 * Enables parallel browser operations from a single Claude Code session
 */
export interface Worker {
  id: string;
  name: string;
  targets: Set<string>;  // CDP target IDs (page IDs)
  context: BrowserContext;
  createdAt: number;
  lastActivityAt: number;
}

export interface WorkerInfo {
  id: string;
  name: string;
  targetCount: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface WorkerCreateOptions {
  id?: string;
  name?: string;
}

export interface Session {
  id: string;
  /** Workers within this session (each with isolated browser context) */
  workers: Map<string, Worker>;
  /** Default worker for backwards compatibility */
  defaultWorkerId: string;
  createdAt: number;
  lastActivityAt: number;
  name: string;
  // Legacy: targets directly on session (for backwards compat)
  targets: Set<string>;
  context?: BrowserContext;
}

export interface SessionInfo {
  id: string;
  targetCount: number;
  workerCount: number;
  workers: WorkerInfo[];
  createdAt: number;
  lastActivityAt: number;
  name: string;
}

export interface SessionCreateOptions {
  id?: string;
  name?: string;
}

export interface SessionEvent {
  type: 'session:created' | 'session:deleted' | 'session:target-added' | 'session:target-removed' | 'worker:created' | 'worker:deleted';
  sessionId: string;
  targetId?: string;
  workerId?: string;
  timestamp: number;
}
