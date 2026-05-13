/**
 * Shared handler factory for `network_capture_lite` and `network_capture_full`.
 *
 * The two tools differ only in `captureMode`. Sharing the handler keeps the
 * mutual-exclusion logic (lite ↔ full per tab) and the input schema in one
 * place.
 */

import { CaptureMode, CaptureOptions } from '../core/network-capture/types';
import {
  NetworkCaptureRecorder,
  deleteActiveRecorder,
  getActiveRecorder,
  setActiveRecorder,
} from '../core/network-capture/recorder';
import { MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

export const NETWORK_CAPTURE_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    tabId: {
      type: 'string',
      description: 'REQUIRED Tab (target) ID',
    },
    action: {
      type: 'string',
      enum: ['start', 'stop', 'getLogs', 'clear'],
      description: 'REQUIRED Action to perform',
    },
    options: {
      type: 'object',
      description: 'CaptureOptions (start only). Defaults: maxEntries=5000, maxBodyBytes=262144 (full mode).',
      properties: {
        maxEntries: { type: 'number' },
        maxBodyBytes: { type: 'number' },
        urlAllowlist: { type: 'array', items: { type: 'string' } },
        urlBlocklist: { type: 'array', items: { type: 'string' } },
        resourceTypes: { type: 'array', items: { type: 'string' } },
      },
    },
    keepBodies: {
      type: 'boolean',
      description: 'On stop: retain on-disk bodies (default false).',
    },
    limit: {
      type: 'number',
      description: 'Max entries to return on getLogs. Default 100; 0 = all.',
    },
  },
  required: ['tabId', 'action'],
};

function jsonResult(payload: unknown, isError = false): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError,
  };
}

/** Setup session-event-driven cleanup once per process. */
const setupCleanupListener = (() => {
  let initialized = false;
  return () => {
    if (initialized) return;
    initialized = true;
    const sessionManager = getSessionManager();
    sessionManager.addEventListener((event) => {
      if (
        event.type === 'session:target-closed' ||
        event.type === 'session:target-removed'
      ) {
        const targetId = event.targetId;
        if (!targetId) return;
        const rec = getActiveRecorder(targetId);
        if (rec) {
          rec.stop({ keepBodies: false }).catch(() => { /* ignore */ });
          deleteActiveRecorder(targetId);
          console.error(`[NetworkCapture] Cleaned up recorder for closed tab ${targetId}`);
        }
      }
    });
  };
})();

export function createNetworkCaptureHandler(captureMode: CaptureMode): ToolHandler {
  const toolName = captureMode === 'lite' ? 'network_capture_lite' : 'network_capture_full';
  return async (sessionId, args): Promise<MCPResult> => {
    const tabId = args.tabId as string | undefined;
    const action = args.action as string | undefined;
    const options = (args.options as Partial<CaptureOptions> | undefined) || undefined;
    const keepBodies = args.keepBodies as boolean | undefined;
    const limit = args.limit as number | undefined;

    setupCleanupListener();

    if (!tabId) return jsonResult({ success: false, error: 'tabId is required' }, true);
    if (!action) return jsonResult({ success: false, error: 'action is required' }, true);

    const sessionManager = getSessionManager();

    try {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, toolName);
      if (!page) {
        return jsonResult({ success: false, error: `Tab ${tabId} not found` }, true);
      }

      switch (action) {
        case 'start': {
          const existing = getActiveRecorder(tabId);
          if (existing) {
            return jsonResult({
              success: false,
              error: 'already_capturing',
              activeMode: existing.getMode(),
            });
          }
          const recorder = new NetworkCaptureRecorder(page, sessionId, captureMode, options);
          recorder.start();
          setActiveRecorder(tabId, recorder);
          return jsonResult({
            success: true,
            action: 'start',
            mode: captureMode,
            tabId,
            options: recorder.getOptions(),
            message: `network_capture_${captureMode} started`,
          });
        }

        case 'stop': {
          const recorder = getActiveRecorder(tabId);
          if (!recorder) {
            return jsonResult({ success: true, action: 'stop', status: 'not_running' });
          }
          if (recorder.getMode() !== captureMode) {
            return jsonResult({
              success: false,
              error: 'mode_mismatch',
              activeMode: recorder.getMode(),
              requestedMode: captureMode,
            });
          }
          const entryCount = recorder.getEntryCount();
          const durationMs = Date.now() - recorder.getStartedAt();
          await recorder.stop({ keepBodies });
          deleteActiveRecorder(tabId);
          return jsonResult({
            success: true,
            action: 'stop',
            mode: captureMode,
            entryCount,
            durationMs,
          });
        }

        case 'getLogs': {
          const recorder = getActiveRecorder(tabId);
          if (!recorder) {
            return jsonResult({ success: true, action: 'getLogs', status: 'not_running', entries: [] });
          }
          if (recorder.getMode() !== captureMode) {
            return jsonResult({
              success: false,
              error: 'mode_mismatch',
              activeMode: recorder.getMode(),
              requestedMode: captureMode,
            });
          }
          const entries = recorder.getLogs(limit);
          return jsonResult({
            success: true,
            action: 'getLogs',
            mode: captureMode,
            entries,
            totalEntries: recorder.getEntryCount(),
            returned: entries.length,
          });
        }

        case 'clear': {
          const recorder = getActiveRecorder(tabId);
          if (!recorder) {
            return jsonResult({ success: true, action: 'clear', status: 'not_running' });
          }
          if (recorder.getMode() !== captureMode) {
            return jsonResult({
              success: false,
              error: 'mode_mismatch',
              activeMode: recorder.getMode(),
              requestedMode: captureMode,
            });
          }
          const before = recorder.getEntryCount();
          recorder.clear();
          return jsonResult({
            success: true,
            action: 'clear',
            mode: captureMode,
            clearedCount: before,
          });
        }

        default:
          return jsonResult({ success: false, error: `Unknown action "${action}"` }, true);
      }
    } catch (err) {
      return jsonResult(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        true,
      );
    }
  };
}
