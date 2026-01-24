/// <reference types="jest" />
/**
 * Mock Session Manager for testing
 */

import { Page } from 'puppeteer-core';
import { createMockPage, createMockCDPClient } from './mock-cdp';

export interface MockSession {
  id: string;
  targets: Set<string>;
  createdAt: number;
  lastActivityAt: number;
  name: string;
}

export interface MockSessionManagerOptions {
  initialSessions?: MockSession[];
}

/**
 * Creates a mock SessionManager for testing tool handlers
 */
export function createMockSessionManager(options: MockSessionManagerOptions = {}) {
  const sessions: Map<string, MockSession> = new Map();
  const targetToSession: Map<string, string> = new Map();
  const pages: Map<string, Page> = new Map();
  const mockCDPClient = createMockCDPClient();

  // Initialize with provided sessions
  if (options.initialSessions) {
    for (const session of options.initialSessions) {
      sessions.set(session.id, session);
      for (const targetId of session.targets) {
        targetToSession.set(targetId, session.id);
      }
    }
  }

  const manager = {
    sessions,
    pages,
    mockCDPClient,

    ensureConnected: jest.fn().mockResolvedValue(undefined),

    createSession: jest.fn().mockImplementation(async (opts: { id?: string; name?: string } = {}) => {
      const id = opts.id || `session-${Date.now()}`;
      const session: MockSession = {
        id,
        targets: new Set(),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        name: opts.name || `Session ${id.slice(0, 8)}`,
      };
      sessions.set(id, session);
      return session;
    }),

    getOrCreateSession: jest.fn().mockImplementation(async (sessionId: string) => {
      let session = sessions.get(sessionId);
      if (!session) {
        session = await manager.createSession({ id: sessionId });
      }
      return session;
    }),

    getSession: jest.fn().mockImplementation((sessionId: string) => {
      return sessions.get(sessionId);
    }),

    deleteSession: jest.fn().mockImplementation(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        for (const targetId of session.targets) {
          pages.delete(targetId);
          targetToSession.delete(targetId);
        }
        sessions.delete(sessionId);
      }
    }),

    touchSession: jest.fn().mockImplementation((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.lastActivityAt = Date.now();
      }
    }),

    createTarget: jest.fn().mockImplementation(async (sessionId: string, url?: string) => {
      await manager.getOrCreateSession(sessionId);
      const targetId = `target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const page = createMockPage({ url: url || 'about:blank', targetId });

      const session = sessions.get(sessionId);
      if (session) {
        session.targets.add(targetId);
      }
      targetToSession.set(targetId, sessionId);
      pages.set(targetId, page);

      return { targetId, page };
    }),

    getPage: jest.fn().mockImplementation(async (sessionId: string, targetId: string) => {
      // Validate ownership
      const owner = targetToSession.get(targetId);
      if (owner !== sessionId) {
        throw new Error(`Target ${targetId} does not belong to session ${sessionId}`);
      }
      return pages.get(targetId) || null;
    }),

    getSessionPages: jest.fn().mockImplementation(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return [];

      const sessionPages: Page[] = [];
      for (const targetId of session.targets) {
        const page = pages.get(targetId);
        if (page) {
          sessionPages.push(page);
        }
      }
      return sessionPages;
    }),

    getSessionTargetIds: jest.fn().mockImplementation((sessionId: string) => {
      const session = sessions.get(sessionId);
      return session ? Array.from(session.targets) : [];
    }),

    validateTargetOwnership: jest.fn().mockImplementation((sessionId: string, targetId: string) => {
      return targetToSession.get(targetId) === sessionId;
    }),

    removeTarget: jest.fn().mockImplementation(async (sessionId: string, targetId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.targets.delete(targetId);
        targetToSession.delete(targetId);
        pages.delete(targetId);
      }
    }),

    getCDPClient: jest.fn().mockReturnValue(mockCDPClient),

    getSessionInfo: jest.fn().mockImplementation((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      return {
        id: session.id,
        targetCount: session.targets.size,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        name: session.name,
      };
    }),

    getAllSessionInfos: jest.fn().mockImplementation(() => {
      return Array.from(sessions.values()).map((s) => ({
        id: s.id,
        targetCount: s.targets.size,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        name: s.name,
      }));
    }),

    get sessionCount() {
      return sessions.size;
    },

    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),

    // Helper methods for testing
    _addPage: (sessionId: string, targetId: string, page: Page) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.targets.add(targetId);
        targetToSession.set(targetId, sessionId);
        pages.set(targetId, page);
      }
    },

    _getPages: () => pages,
    _getSessions: () => sessions,
  };

  return manager;
}

/**
 * Creates a simple mock RefIdManager for testing
 */
export function createMockRefIdManager() {
  const refs: Map<string, Map<string, Map<string, { refId: string; backendDOMNodeId: number; role: string; name?: string; createdAt: number }>>> = new Map();
  const counters: Map<string, Map<string, number>> = new Map();

  return {
    generateRef: jest.fn().mockImplementation(
      (sessionId: string, targetId: string, backendDOMNodeId: number, role: string, name?: string) => {
        if (!refs.has(sessionId)) {
          refs.set(sessionId, new Map());
        }
        if (!refs.get(sessionId)!.has(targetId)) {
          refs.get(sessionId)!.set(targetId, new Map());
        }
        if (!counters.has(sessionId)) {
          counters.set(sessionId, new Map());
        }
        if (!counters.get(sessionId)!.has(targetId)) {
          counters.get(sessionId)!.set(targetId, 0);
        }

        const counter = counters.get(sessionId)!.get(targetId)! + 1;
        counters.get(sessionId)!.set(targetId, counter);

        const refId = `ref_${counter}`;
        refs.get(sessionId)!.get(targetId)!.set(refId, {
          refId,
          backendDOMNodeId,
          role,
          name,
          createdAt: Date.now(),
        });

        return refId;
      }
    ),

    getRef: jest.fn().mockImplementation((sessionId: string, targetId: string, refId: string) => {
      return refs.get(sessionId)?.get(targetId)?.get(refId);
    }),

    getBackendDOMNodeId: jest.fn().mockImplementation((sessionId: string, targetId: string, refId: string) => {
      return refs.get(sessionId)?.get(targetId)?.get(refId)?.backendDOMNodeId;
    }),

    clearTargetRefs: jest.fn().mockImplementation((sessionId: string, targetId: string) => {
      refs.get(sessionId)?.delete(targetId);
      counters.get(sessionId)?.set(targetId, 0);
    }),

    clearSessionRefs: jest.fn().mockImplementation((sessionId: string) => {
      refs.delete(sessionId);
      counters.delete(sessionId);
    }),

    getTargetRefs: jest.fn().mockImplementation((sessionId: string, targetId: string) => {
      const targetRefs = refs.get(sessionId)?.get(targetId);
      return targetRefs ? Array.from(targetRefs.values()) : [];
    }),
  };
}
