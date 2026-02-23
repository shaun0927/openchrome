/// <reference types="jest" />
/**
 * Mock Session Manager for testing
 * Updated to support Worker architecture (v3.0)
 */

import { Page } from 'puppeteer-core';
import { createMockPage, createMockCDPClient } from './mock-cdp';

export interface MockWorker {
  id: string;
  name: string;
  targets: Set<string>;
  createdAt: number;
  lastActivityAt: number;
}

export interface MockWorkerInfo {
  id: string;
  name: string;
  targetCount: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface MockSession {
  id: string;
  workers: Map<string, MockWorker>;
  defaultWorkerId: string;
  targets: Set<string>;  // Legacy
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
  const targetToWorker: Map<string, { sessionId: string; workerId: string }> = new Map();
  const pages: Map<string, Page> = new Map();
  const mockCDPClient = createMockCDPClient();

  // Initialize with provided sessions
  if (options.initialSessions) {
    for (const session of options.initialSessions) {
      sessions.set(session.id, session);
      for (const worker of session.workers.values()) {
        for (const targetId of worker.targets) {
          targetToWorker.set(targetId, { sessionId: session.id, workerId: worker.id });
        }
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
      const defaultWorkerId = 'default';

      // Create default worker
      const defaultWorker: MockWorker = {
        id: defaultWorkerId,
        name: 'Default Worker',
        targets: new Set(),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };

      const session: MockSession = {
        id,
        workers: new Map([[defaultWorkerId, defaultWorker]]),
        defaultWorkerId,
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
        for (const worker of session.workers.values()) {
          for (const targetId of worker.targets) {
            pages.delete(targetId);
            targetToWorker.delete(targetId);
          }
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

    // Worker management
    createWorker: jest.fn().mockImplementation(async (sessionId: string, opts: { id?: string; name?: string } = {}) => {
      const session = await manager.getOrCreateSession(sessionId);
      const workerId = opts.id || `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const worker: MockWorker = {
        id: workerId,
        name: opts.name || `Worker ${workerId}`,
        targets: new Set(),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };

      session.workers.set(workerId, worker);
      return worker;
    }),

    getWorker: jest.fn().mockImplementation((sessionId: string, workerId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      return session.workers.get(workerId);
    }),

    getOrCreateWorker: jest.fn().mockImplementation(async (sessionId: string, workerId?: string) => {
      const session = await manager.getOrCreateSession(sessionId);
      const targetWorkerId = workerId || session.defaultWorkerId;

      let worker = session.workers.get(targetWorkerId);
      if (!worker) {
        worker = await manager.createWorker(sessionId, { id: targetWorkerId });
      }
      return worker;
    }),

    getWorkers: jest.fn().mockImplementation((sessionId: string): MockWorkerInfo[] => {
      const session = sessions.get(sessionId);
      if (!session) return [];

      return Array.from(session.workers.values()).map((w) => ({
        id: w.id,
        name: w.name,
        targetCount: w.targets.size,
        createdAt: w.createdAt,
        lastActivityAt: w.lastActivityAt,
      }));
    }),

    deleteWorker: jest.fn().mockImplementation(async (sessionId: string, workerId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;

      if (workerId === session.defaultWorkerId) {
        throw new Error('Cannot delete the default worker. Delete the session instead.');
      }

      const worker = session.workers.get(workerId);
      if (worker) {
        for (const targetId of worker.targets) {
          pages.delete(targetId);
          targetToWorker.delete(targetId);
        }
        session.workers.delete(workerId);
      }
    }),

    getWorkerTargetIds: jest.fn().mockImplementation((sessionId: string, workerId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return [];
      const worker = session.workers.get(workerId);
      if (!worker) return [];
      return Array.from(worker.targets);
    }),

    // Target management (updated for workers)
    createTarget: jest.fn().mockImplementation(async (sessionId: string, url?: string, workerId?: string) => {
      const worker = await manager.getOrCreateWorker(sessionId, workerId);
      const targetId = `target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const page = createMockPage({ url: url || 'about:blank', targetId });

      worker.targets.add(targetId);
      worker.lastActivityAt = Date.now();
      targetToWorker.set(targetId, { sessionId, workerId: worker.id });
      pages.set(targetId, page);

      return { targetId, page, workerId: worker.id };
    }),

    getPage: jest.fn().mockImplementation(async (sessionId: string, targetId: string, workerId?: string) => {
      // Validate ownership
      const owner = targetToWorker.get(targetId);
      if (!owner || owner.sessionId !== sessionId) {
        throw new Error(`Target ${targetId} does not belong to session ${sessionId}`);
      }
      if (workerId && owner.workerId !== workerId) {
        throw new Error(`Target ${targetId} does not belong to worker ${workerId}`);
      }
      return pages.get(targetId) || null;
    }),

    getSessionPages: jest.fn().mockImplementation(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return [];

      const sessionPages: Page[] = [];
      for (const worker of session.workers.values()) {
        for (const targetId of worker.targets) {
          const page = pages.get(targetId);
          if (page) {
            sessionPages.push(page);
          }
        }
      }
      return sessionPages;
    }),

    getSessionTargetIds: jest.fn().mockImplementation((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return [];

      const allTargets: string[] = [];
      for (const worker of session.workers.values()) {
        allTargets.push(...worker.targets);
      }
      return allTargets;
    }),

    validateTargetOwnership: jest.fn().mockImplementation((sessionId: string, targetId: string) => {
      const owner = targetToWorker.get(targetId);
      return owner?.sessionId === sessionId;
    }),

    getTargetWorkerId: jest.fn().mockImplementation((targetId: string) => {
      return targetToWorker.get(targetId)?.workerId;
    }),

    isTargetValid: jest.fn().mockImplementation(async (targetId: string) => {
      const page = pages.get(targetId);
      return page !== null && page !== undefined;
    }),

    removeTarget: jest.fn().mockImplementation(async (sessionId: string, targetId: string) => {
      const owner = targetToWorker.get(targetId);
      if (owner && owner.sessionId === sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          const worker = session.workers.get(owner.workerId);
          if (worker) {
            worker.targets.delete(targetId);
          }
        }
        targetToWorker.delete(targetId);
        pages.delete(targetId);
      }
    }),

    getCDPClient: jest.fn().mockReturnValue(mockCDPClient),

    getSessionInfo: jest.fn().mockImplementation((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return undefined;

      let totalTargets = 0;
      const workers: MockWorkerInfo[] = [];

      for (const worker of session.workers.values()) {
        totalTargets += worker.targets.size;
        workers.push({
          id: worker.id,
          name: worker.name,
          targetCount: worker.targets.size,
          createdAt: worker.createdAt,
          lastActivityAt: worker.lastActivityAt,
        });
      }

      return {
        id: session.id,
        targetCount: totalTargets,
        workerCount: session.workers.size,
        workers,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        name: session.name,
      };
    }),

    getAllSessionInfos: jest.fn().mockImplementation(() => {
      return Array.from(sessions.keys()).map((id) => manager.getSessionInfo(id));
    }),

    get sessionCount() {
      return sessions.size;
    },

    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),

    // Helper methods for testing
    _addPage: (sessionId: string, targetId: string, page: Page, workerId?: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        const targetWorkerId = workerId || session.defaultWorkerId;
        const worker = session.workers.get(targetWorkerId);
        if (worker) {
          worker.targets.add(targetId);
          targetToWorker.set(targetId, { sessionId, workerId: targetWorkerId });
          pages.set(targetId, page);
        }
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

    resolveToBackendNodeId: jest.fn().mockImplementation((sessionId: string, targetId: string, refOrNodeId: string) => {
      // 1. Try as ref_N
      const entry = refs.get(sessionId)?.get(targetId)?.get(refOrNodeId);
      if (entry) return entry.backendDOMNodeId;

      // 2. Try as raw integer
      const asNum = parseInt(refOrNodeId, 10);
      if (!isNaN(asNum) && asNum > 0 && String(asNum) === refOrNodeId && asNum <= 2147483647) return asNum;

      // 3. Try as node_N
      if (refOrNodeId.startsWith('node_')) {
        const suffix = refOrNodeId.slice(5);
        const n = parseInt(suffix, 10);
        if (!isNaN(n) && n > 0 && String(n) === suffix && n <= 2147483647) return n;
      }

      return undefined;
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
