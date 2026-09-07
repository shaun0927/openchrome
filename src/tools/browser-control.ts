import type { MCPServer } from '../mcp-server';
import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../core/perception/ref-id-manager';
import { markFrameDirty } from '../core/perception/snapshot-cache-helper';
import { getGlobalConfig } from '../config/global';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';

const definition: MCPToolDefinition = {
  name: 'oc_browser_control',
  description: 'Observe a managed tab, check caller-supplied page/account conditions, or pause automatic input for explicit human control. Wait for phase=human before typing; this drains tracked tool handlers, not page timers or background requests. Resume requires the returned lease and expected URL. No automatic visible-browser restart.',
  annotations: TOOL_ANNOTATIONS.oc_browser_control,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'verify', 'pause', 'resume'], description: 'REQUIRED Control action.' },
      tabId: { type: 'string', description: 'REQUIRED Managed target ID.' },
      lease: { type: 'string', description: 'Lease returned by pause; required for explicit resume.' },
      expectedUrl: { type: 'string', description: 'Exact URL required for verify/resume. Query and fragment are compared but not echoed.' },
      selector: { type: 'string', description: 'Optional CSS selector that must resolve to a visible element in the current page.' },
      expectedText: { type: 'string', description: 'Optional exact trimmed text of the selected account/status element.' },
      reveal: { type: 'boolean', description: 'Explicitly bring a visible browser tab forward after input has drained. Headless requires an operator-controlled restart instead.' },
    },
    required: ['action', 'tabId'],
  },
};

const json = (value: Record<string, unknown>, isError = false): MCPResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError } : {}),
});

export function registerBrowserControlTool(server: MCPServer): void {
  server.registerTool(definition.name, async (sessionId, args, context) => {
    try {
      const { action, tabId } = args;
      if (typeof tabId !== 'string' || !['status', 'verify', 'pause', 'resume'].includes(String(action))) throw new Error('Invalid control request');
      const manager = getSessionManager();
      if (!manager.validateTargetOwnership(sessionId, tabId)) throw new Error('Target unavailable in this session');
      const page = await manager.getPage(sessionId, tabId);
      if (!page || page.isClosed()) throw new Error('Target closed');
      if (context?.signal?.aborted) throw new Error('Control request cancelled');
      const operations = server.browserOperations;
      if (action === 'pause') {
        operations.pause(sessionId, tabId);
        manager.setTargetHumanControl(sessionId, tabId, true);
      }
      if (action === 'resume') {
        if (typeof args.lease !== 'string') throw new Error('Resume requires a lease');
        operations.assertResumable(sessionId, tabId, args.lease);
      }
      let verified = false;
      if (action === 'verify' || action === 'resume') {
        if (typeof args.expectedUrl !== 'string' || page.url() !== args.expectedUrl) throw new Error('Expected URL did not match; control remains paused if held');
        if (args.expectedText !== undefined && typeof args.selector !== 'string') throw new Error('expectedText requires selector');
        if (typeof args.selector === 'string') {
          verified = await page.evaluate((selector: string, expected: string | null) => {
            const element = document.querySelector(selector);
            if (!element || element.getClientRects().length === 0) return false;
            const style = getComputedStyle(element);
            return style.visibility !== 'hidden' && style.display !== 'none' &&
              (expected === null || element.textContent?.trim() === expected);
          }, args.selector, typeof args.expectedText === 'string' ? args.expectedText : null);
          if (!verified) throw new Error('Page condition did not match; control remains paused if held');
        } else verified = true;
        if (page.url() !== args.expectedUrl) throw new Error('Page navigated during verification');
      }
      if (context?.signal?.aborted) throw new Error('Control request cancelled');
      if (action === 'resume') {
        getRefIdManager().clearTargetRefs(sessionId, tabId);
        markFrameDirty(page);
        operations.resume(sessionId, tabId, args.lease as string);
        manager.setTargetHumanControl(sessionId, tabId, false);
      }
      const state = operations.status(sessionId, tabId);
      let revealed = false;
      if (args.reveal === true && action === 'pause' && state.phase === 'human' && !getGlobalConfig().headless) {
        await page.bringToFront();
        revealed = true;
      }
      const url = new URL(page.url());
      return json({ sessionId, tabId, url: url.origin === 'null' ? `${url.protocol}${url.pathname}` : `${url.origin}${url.pathname}`, ...state, revealed,
        ...(args.reveal === true && getGlobalConfig().headless ? { visibilityRecovery: 'Headless cannot reveal this window. Keep the lease paused; use a deliberately configured visible browser and revalidate state.' } : {}),
        ...(action === 'verify' || action === 'resume' ? { conditionPassed: verified, authentication: 'unverified', verificationSource: 'caller_supplied_page_condition' } : {}),
      });
    } catch {
      return json({ code: 'BROWSER_CONTROL_FAILED', message: 'Control or page verification failed. Query status and check target, lease and expected page; no automatic resume was performed.' }, true);
    }
  }, definition);
}
