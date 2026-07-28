/** Explicit, verified foreground activation for one authorized Chrome target. */

import type { Page } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import {
  getRemainingBudget,
  throwIfAborted,
  type MCPResult,
  type MCPToolDefinition,
  type ToolContext,
  type ToolHandler,
} from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { wrapMutatingHandler } from '../utils/snapshot-cache-helper';

const DEFAULT_ACTIVATION_DEADLINE_MS = 5000;
const MAX_ACTIVATION_ATTEMPTS = 3;

export type TabsActivationOutcome = 'verified' | 'inconclusive' | 'superseded';

export interface TabsActivationFacts {
  tabId: string;
  activated: boolean;
  outcome: TabsActivationOutcome;
  visibilityState: string;
  documentFocused: boolean;
  attempts: number;
  activationSent: boolean;
  windowForegroundAttempted: false;
  pathTaken: 'Target.activateTarget';
  verificationError?: string;
}

export interface ActivationQueueResult<T> {
  sequence: number;
  superseded: boolean;
  value: T;
}

/**
 * Serializes only foreground activation requests. Other browser work and
 * per-target queues remain independent.
 */
export class BrowserActivationCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private latestSequence = 0;

  enqueue<T>(run: () => Promise<T>): Promise<ActivationQueueResult<T>> {
    const sequence = ++this.latestSequence;
    const predecessor = this.tail.catch(() => undefined);
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });

    return predecessor
      .then(async () => {
        const value = await run();
        return {
          sequence,
          superseded: sequence < this.latestSequence,
          value,
        };
      })
      .finally(release);
  }
}

let activationCoordinator = new BrowserActivationCoordinator();

export function resetTabsActivationCoordinatorForTesting(): void {
  activationCoordinator = new BrowserActivationCoordinator();
}

class ActivationDeadlineError extends Error {
  constructor(label: string) {
    super(`${label} timed out before the tool deadline`);
    this.name = 'ActivationDeadlineError';
  }
}

function remainingBudget(context: ToolContext | undefined, fallbackDeadlineAt: number): number {
  return context
    ? getRemainingBudget(context)
    : Math.max(0, fallbackDeadlineAt - Date.now());
}

async function runBounded<T>(
  operation: () => Promise<T>,
  context: ToolContext | undefined,
  fallbackDeadlineAt: number,
  label: string,
): Promise<T> {
  throwIfAborted(context);
  const remaining = remainingBudget(context, fallbackDeadlineAt);
  if (remaining <= 0) throw new ActivationDeadlineError(label);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => {
      const reason = context?.signal?.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted')));
    });
    const timer = setTimeout(
      () => finish(() => reject(new ActivationDeadlineError(label))),
      remaining,
    );
    timer.unref?.();
    context?.signal?.addEventListener('abort', onAbort, { once: true });

    operation().then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inconclusiveFacts(
  tabId: string,
  verificationError: string,
  attempts = 0,
  activationSent = false,
  visibilityState = 'unknown',
  documentFocused = false,
): TabsActivationFacts {
  return {
    tabId,
    activated: false,
    outcome: 'inconclusive',
    visibilityState,
    documentFocused,
    attempts,
    activationSent,
    windowForegroundAttempted: false,
    pathTaken: 'Target.activateTarget',
    verificationError,
  };
}

export async function activatePageWithVerification(options: {
  page: Page;
  tabId: string;
  context?: ToolContext;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TabsActivationFacts> {
  const { page, tabId, context } = options;
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? MAX_ACTIVATION_ATTEMPTS, MAX_ACTIVATION_ATTEMPTS));
  const sleep = options.sleep ?? defaultSleep;
  const fallbackDeadlineAt = Date.now() + DEFAULT_ACTIVATION_DEADLINE_MS;
  let cdpSession;
  try {
    cdpSession = await runBounded(
      () => page.target().createCDPSession(),
      context,
      fallbackDeadlineAt,
      'tabs_activate CDP session creation',
    );
  } catch (error) {
    if (context?.signal?.aborted) throw error;
    return inconclusiveFacts(tabId, errorMessage(error));
  }

  let attempts = 0;
  let activationSent = false;
  let visibilityState = 'unknown';
  let documentFocused = false;
  let verificationError: string | undefined;

  try {
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      throwIfAborted(context);
      try {
        await runBounded(
          () => cdpSession.send('Target.activateTarget', { targetId: tabId }),
          context,
          fallbackDeadlineAt,
          'Target.activateTarget',
        );
        activationSent = true;
      } catch (error) {
        verificationError = errorMessage(error);
        break;
      }

      try {
        await runBounded(
          () => sleep(100 * attempts),
          context,
          fallbackDeadlineAt,
          'tabs_activate verification delay',
        );
        const observation = await runBounded(
          () => page.evaluate(() => ({
            visibilityState: document.visibilityState,
            documentFocused: document.hasFocus(),
          })),
          context,
          fallbackDeadlineAt,
          'tabs_activate visibility verification',
        ) as { visibilityState?: unknown; documentFocused?: unknown };
        visibilityState = typeof observation?.visibilityState === 'string'
          ? observation.visibilityState
          : 'unknown';
        documentFocused = observation?.documentFocused === true;
        verificationError = undefined;
        if (visibilityState === 'visible') {
          return {
            tabId,
            activated: true,
            outcome: 'verified',
            visibilityState,
            documentFocused,
            attempts,
            activationSent,
            windowForegroundAttempted: false,
            pathTaken: 'Target.activateTarget',
          };
        }
      } catch (error) {
        if (context?.signal?.aborted) throw error;
        verificationError = errorMessage(error);
        if (remainingBudget(context, fallbackDeadlineAt) <= 0) break;
      }
    }
  } finally {
    await runBounded(
      () => cdpSession.detach(),
      context,
      fallbackDeadlineAt,
      'tabs_activate CDP session detach',
    ).catch(() => undefined);
  }

  return inconclusiveFacts(
    tabId,
    verificationError ?? 'Activation could not be verified',
    Math.min(attempts, maxAttempts),
    activationSent,
    visibilityState,
    documentFocused,
  );
}

const definition: MCPToolDefinition = {
  name: 'tabs_activate',
  description: 'Explicitly activate an authorized Chrome tab and verify document visibility. Visibly changes the active tab; CDP-only mode never invokes an OS foreground helper.',
  category: 'tabs',
  annotations: TOOL_ANNOTATIONS.tabs_activate,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'REQUIRED Target ID returned by tabs_create or tabs_context',
      },
      workerId: {
        type: 'string',
        description: 'Optional worker ownership scope to enforce before activation',
      },
      windowForeground: {
        type: 'string',
        enum: ['cdp-only'],
        default: 'cdp-only',
        description: 'Foreground path. Only cdp-only is supported; no OS process/window activation is attempted.',
      },
    },
    required: ['tabId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      activated: { type: 'boolean' },
      outcome: { type: 'string', enum: ['verified', 'inconclusive', 'superseded'] },
      visibilityState: { type: 'string' },
      documentFocused: { type: 'boolean' },
      attempts: { type: 'integer', minimum: 0, maximum: MAX_ACTIVATION_ATTEMPTS },
      activationSent: { type: 'boolean' },
      windowForegroundAttempted: { type: 'boolean', const: false },
      pathTaken: { type: 'string', const: 'Target.activateTarget' },
      superseded: { type: 'boolean' },
      requestSequence: { type: 'integer', minimum: 1 },
      verificationError: { type: 'string' },
    },
    required: [
      'tabId',
      'activated',
      'outcome',
      'visibilityState',
      'documentFocused',
      'attempts',
      'activationSent',
      'windowForegroundAttempted',
      'pathTaken',
      'superseded',
      'requestSequence',
    ],
  },
};

function structuredResult(payload: Record<string, unknown>): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const handler: ToolHandler = async (sessionId, args, context): Promise<MCPResult> => {
  const tabId = typeof args.tabId === 'string' ? args.tabId : '';
  const workerId = typeof args.workerId === 'string' ? args.workerId : undefined;
  const windowForeground = args.windowForeground ?? 'cdp-only';
  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error activating tab: tabId is required' }], isError: true };
  }
  if (windowForeground !== 'cdp-only') {
    return {
      content: [{ type: 'text', text: 'Error activating tab: windowForeground must be "cdp-only"' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  try {
    const authorizedPage = await sessionManager.getPage(sessionId, tabId, workerId, 'tabs_activate');
    if (!authorizedPage) throw new Error(`Page not found for target ${tabId}`);

    const queued = await activationCoordinator.enqueue(async () => sessionManager.runTargetExclusive(
      sessionId,
      tabId,
      async () => {
        if (context && getRemainingBudget(context) <= 0) {
          return inconclusiveFacts(tabId, 'tabs_activate timed out while waiting for the activation queue');
        }
        const page = await sessionManager.getPage(sessionId, tabId, workerId, 'tabs_activate');
        if (!page) throw new Error(`Page not found for target ${tabId}`);
        return activatePageWithVerification({ page, tabId, context });
      },
    ));

    const payload: Record<string, unknown> = {
      ...queued.value,
      outcome: queued.superseded ? 'superseded' : queued.value.outcome,
      superseded: queued.superseded,
      requestSequence: queued.sequence,
    };
    return structuredResult(payload);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error activating tab: ${errorMessage(error)}` }],
      isError: true,
    };
  }
};

export function registerTabsActivateTool(server: MCPServer): void {
  const wrapped = wrapMutatingHandler(handler, (sessionId, tabId) => (
    tabId
      ? getSessionManager().getPage(sessionId, tabId, undefined, 'tabs_activate')
      : Promise.resolve(null)
  ));
  server.registerTool('tabs_activate', wrapped, definition);
}
