/**
 * Interact Tool - Composite tool that finds an element, performs an action,
 * waits for stability, and returns a comprehensive state summary.
 *
 * Reduces multi-step find→click→screenshot sequences to a single call.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget, throwIfAborted } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager, formatStaleRefError, makeStaleRefError } from '../utils/ref-id-manager';
import { withDomDelta } from '../utils/dom-delta';
import { DEFAULT_DOM_SETTLE_DELAY_MS, DEFAULT_SCREENSHOT_RACE_TIMEOUT_MS, DEFAULT_SCREENSHOT_TIMEOUT_MS } from '../config/defaults';
import { FoundElement, normalizeQuery, scoreElement, tokenizeQuery } from '../utils/element-finder';
import { discoverElements, getTaggedElementRect, cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';
import { withTimeout } from '../utils/with-timeout';
import { resolveElementsByAXTree, invalidateAXCache, MATCH_LEVEL_LABELS } from '../utils/ax-element-resolver';
import { getTargetId } from '../utils/puppeteer-helpers';
import { classifyOutcome, formatOutcomeLine } from '../utils/ralph/outcome-classifier';
import { getCircuitBreaker } from '../utils/ralph/circuit-breaker';
import { humanMouseMove } from '../stealth/human-behavior';
import { wrapMutatingHandler } from '../utils/snapshot-cache-helper';
import {
  appendReturnAfterState,
  parseReturnAfterState,
  RETURN_AFTER_STATE_SCHEMA,
  type ReturnAfterState,
} from './_shared/return-after-state';
import {
  formatNodeRefToken,
  formatUidEvictedError,
  getCurrentLoaderId,
  isNodeRefEnabled,
  mintNodeRefSync,
  resolveNodeRef,
} from '../core/perception/node-ref';
import { dispatchCoordinateClick } from '../cdp/input';
import { coerceVerifyMode, runVerify, VERIFY_FIELD_SCHEMA, VerifyReport } from '../core/perception/verify';
import { guardIrreversibleBrowserAction } from '../harness/irreversible-action';

/**
 * Inject the structured {@link VerifyReport} onto an MCPResult under
 * `result.verify` (mirrors the issue #827 schema). When the report is
 * undefined we return the input unchanged — this keeps the default
 * `verify: 'none' | false | absent` path byte-identical to develop.
 */
function attachVerifyReport(result: MCPResult, report: VerifyReport | undefined): MCPResult {
  if (!report) return result;
  return { ...result, verify: report };
}

const definition: MCPToolDefinition = {
  name: 'interact',
  description: 'Click/hover/double_click an element by natural language; waits for DOM to settle, returns a state summary.\n\nWhen to use: single-call click on an element described in plain language. For Shadow DOM / canvas / cross-origin iframes, screenshot first and pass mode:"coordinate".\nWhen NOT to use: prefer computer for generic coordinate clicks, or act for multi-step sequences.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      query: {
        type: 'string',
        description: 'Element to act on (natural language). Required when mode is "ref" (default).',
      },
      mode: {
        type: 'string',
        enum: ['ref', 'coordinate'],
        default: 'ref',
        description: 'Dispatch mode. "ref" (default) resolves the element by query; "coordinate" sends a CDP mouse event directly to pixel coordinates.',
      },
      coordinate: {
        type: 'object',
        description: 'Pixel coordinates for coordinate mode. Required when mode is "coordinate".',
        properties: {
          x: { type: 'integer', minimum: 0 },
          y: { type: 'integer', minimum: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
          clickCount: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] },
          },
        },
        required: ['x', 'y'],
      },
      nodeRef: {
        type: 'string',
        description:
          'Stable backend-node uid (e.g. "n_42") issued by a prior read_page/query_dom/inspect call. When provided, bypasses element discovery. On a uid that was evicted by navigation, returns a structured "uid_evicted" error.',
      },
      action: {
        type: 'string',
        enum: ['click', 'double_click', 'hover'],
        description: 'Action to perform. Default: click',
      },
      waitAfter: {
        type: 'number',
        description: 'DOM settle wait in ms. Default: 500',
      },
      returnFormat: {
        type: 'string',
        enum: ['state_summary', 'dom_delta', 'both'],
        description: 'Response content. Default: both',
      },
      verify: VERIFY_FIELD_SCHEMA,
      waitForMs: {
        type: 'number',
        description: 'Poll timeout for element in ms. Max: 30000',
      },
      pollInterval: {
        type: 'number',
        description: 'Poll interval in ms. Default: 200',
      },
      returnAfterState: RETURN_AFTER_STATE_SCHEMA,
      ref: {
        type: 'string',
        description:
          'Optional element ref from a recent read_page(mode="ax") snapshot. ' +
          'When supplied and fresh, the tool skips DOM/AX re-resolution. ' +
          'Stale or unknown refs return a STALE_REF error — call read_page again.',
      },
    },
    // `query` is no longer strictly required: a caller can pass `nodeRef`
    // instead. We validate at runtime so the JSON-schema stays minimal and
    // P2-stable (the schema does not change shape regardless of the
    // OPENCHROME_NODE_REF flag value).
    required: ['tabId'],
  },
};

/**
 * Shared post-action response builder.
 *
 * Both the ref fast-path and the AX/CSS resolution paths funnel through this
 * helper so that `verify`, `returnFormat`, state-summary, and DOM-delta
 * output behave identically regardless of which path produced the action.
 *
 * #948 codex P1: this was previously inlined in the AX/CSS branches only, so
 * the ref path silently dropped `verify=true` screenshots and
 * `returnFormat='state_summary' | 'both'` summaries.
 */
type PostActionInput = {
  page: any;
  context: ToolContext | undefined;
  headerLine: string;
  delta: string | null | undefined;
  returnFormat: string;
  verify: boolean | undefined;
  verifyReport?: VerifyReport;
  extraTopLevel?: Record<string, unknown>;
  sessionId?: string;
  tabId?: string;
  returnAfterState?: ReturnAfterState;
};

async function buildPostActionResponse(input: PostActionInput): Promise<MCPResult> {
  const {
    page,
    context,
    headerLine,
    delta,
    returnFormat,
    verify,
    verifyReport,
    extraTopLevel,
    sessionId,
    tabId,
    returnAfterState = 'none',
  } = input;

  const lines: string[] = [headerLine];

  if ((returnFormat === 'dom_delta' || returnFormat === 'both') && delta) {
    lines.push(delta);
  }

  if (returnFormat === 'state_summary' || returnFormat === 'both') {
    type StateSummary = {
      url: string;
      title: string;
      scrollX: number;
      scrollY: number;
      activeInfo: string;
      panels: string[];
      headings: string[];
    };
    const stateSummary = (await withTimeout(page.evaluate(() => {
      const url = window.location.href;
      const title = document.title;
      const scrollX = Math.round(window.scrollX);
      const scrollY = Math.round(window.scrollY);

      const active = document.activeElement;
      let activeInfo = 'none';
      if (active && active !== document.body) {
        const inputEl = active as HTMLInputElement;
        const role =
          active.getAttribute('role') ||
          (active.tagName === 'BUTTON'
            ? 'button'
            : active.tagName === 'INPUT'
              ? inputEl.type || 'textbox'
              : active.tagName.toLowerCase());
        const name =
          active.getAttribute('aria-label') ||
          active.getAttribute('title') ||
          active.textContent?.trim().slice(0, 40) ||
          '';
        activeInfo = `${role}${name ? ` "${name}"` : ''}`;
      }

      const panels: string[] = [];
      const panelSelectors = [
        '[role="tabpanel"]',
        '[role="dialog"]',
        '[role="main"]',
        'main',
        '.panel',
        '[class*="panel"]',
        '[class*="content"]',
      ];
      for (const sel of panelSelectors) {
        if (panels.length >= 3) break;
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (panels.length >= 3) break;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const text = el.textContent?.trim().slice(0, 80) || '';
            if (text.length > 10) {
              panels.push(text);
            }
          }
        } catch {
          // skip bad selectors
        }
      }

      const headings: string[] = [];
      for (const hEl of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
        const rect = hEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(hEl);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = hEl.textContent?.trim().slice(0, 60) || '';
        if (text) headings.push(text);
        if (headings.length >= 3) break;
      }

      return { url, title, scrollX, scrollY, activeInfo, panels, headings };
    }), 10000, 'interact', context).catch(() => ({
      url: '', title: '', scrollX: 0, scrollY: 0,
      activeInfo: 'unknown', panels: [] as string[], headings: [] as string[],
    }))) as StateSummary;

    lines.push(
      `[State Summary] url: ${stateSummary.url} | scroll: ${stateSummary.scrollX},${stateSummary.scrollY} | active: ${stateSummary.activeInfo}`
    );
    const headings = Array.isArray(stateSummary.headings) ? stateSummary.headings : [];
    const panels = Array.isArray(stateSummary.panels) ? stateSummary.panels : [];
    if (headings.length > 0) {
      lines.push(`[Headings] ${headings.map((h: string) => `"${h}"`).join(' | ')}`);
    }
    if (panels.length > 0) {
      const panelParts = panels.map((p: string, i: number) => `Panel ${i + 1}: "${p}"`);
      lines.push(`[Visible] ${panelParts.join(' | ')}`);
    }
  }

  // Optional screenshot verification — WebP via CDP, fallback to Puppeteer PNG.
  let screenshotContent: { type: 'image'; data: string; mimeType: string } | null = null;
  if (verify) {
    try {
      const screenshotResult = await Promise.race([
        (async () => {
          const cdpSession = await (page as any).target().createCDPSession();
          try {
            const { data } = await cdpSession.send('Page.captureScreenshot', {
              format: 'webp',
              quality: 60,
              optimizeForSpeed: true,
            });
            return { data: data as string, mimeType: 'image/webp' };
          } finally {
            await cdpSession.detach().catch(() => {});
          }
        })(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), DEFAULT_SCREENSHOT_RACE_TIMEOUT_MS)),
      ]);

      if (screenshotResult) {
        screenshotContent = { type: 'image' as const, ...screenshotResult };
      } else {
        throw new Error('CDP screenshot timed out');
      }
    } catch {
      try {
        let fallbackTimer: NodeJS.Timeout;
        const screenshot = await Promise.race([
          page.screenshot({ encoding: 'base64', type: 'png', fullPage: false }).finally(() => clearTimeout(fallbackTimer)),
          new Promise<never>((_, reject) => {
            fallbackTimer = setTimeout(() => reject(new Error('Fallback screenshot timed out')), DEFAULT_SCREENSHOT_TIMEOUT_MS);
          }),
        ]);
        screenshotContent = { type: 'image' as const, data: screenshot as unknown as string, mimeType: 'image/png' };
      } catch {
        // Screenshot failure is non-fatal
      }
    }
  }

  const responseContent: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
    { type: 'text', text: lines.join('\n') },
  ];
  if (screenshotContent) responseContent.push(screenshotContent);

  const result = attachVerifyReport({
    content: responseContent,
    ...(extraTopLevel || {}),
  } as MCPResult, verifyReport);
  if (sessionId && tabId) {
    await appendReturnAfterState(result, page, sessionId, tabId, returnAfterState, context);
  }
  return result;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  throwIfAborted(context);
  const tabId = args.tabId as string;
  const mode = (args.mode as string) || 'ref';
  const query = args.query as string | undefined;
  const ref = args.ref as string | undefined;
  const nodeRefArg = typeof args.nodeRef === 'string' ? (args.nodeRef as string) : undefined;
  const coordinateArg = args.coordinate as Record<string, unknown> | undefined;
  const action = (args.action as string) || 'click';
  const waitAfter = Math.min(Math.max((args.waitAfter as number) || 500, 0), 10000);
  const returnFormat = (args.returnFormat as string) || 'both';
  const verifyMode = coerceVerifyMode(args.verify);
  const waitForMs = args.waitForMs as number | undefined;
  const pollInterval = Math.min(Math.max((args.pollInterval as number) || 200, 50), 2000);
  const returnAfterState = parseReturnAfterState(args.returnAfterState);

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  // ─── Mode: coordinate ───
  if (mode === 'coordinate') {
    if (query || ref || nodeRefArg) {
      return {
        content: [{ type: 'text', text: 'INVALID_SCHEMA: "query"/"ref"/"nodeRef" must not be provided when mode is "coordinate". Use "coordinate" block instead.' }],
        isError: true,
      };
    }
    if (!coordinateArg) {
      return {
        content: [{ type: 'text', text: 'INVALID_SCHEMA: "coordinate" block is required when mode is "coordinate".' }],
        isError: true,
      };
    }
    const cx = coordinateArg.x as number;
    const cy = coordinateArg.y as number;
    if (typeof cx !== 'number' || typeof cy !== 'number') {
      return {
        content: [{ type: 'text', text: 'INVALID_SCHEMA: coordinate.x and coordinate.y must be integers.' }],
        isError: true,
      };
    }

    try {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, 'interact');
      if (!page) {
        return {
          content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.` }],
          isError: true,
        };
      }

      // Viewport clamping
      const viewport = page.viewport() ?? await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })).catch(() => null);

      if (viewport && (cx > viewport.width || cy > viewport.height || cx < 0 || cy < 0)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'OOB_COORDINATE',
              message: `Coordinates (${cx}, ${cy}) are outside viewport bounds.`,
              viewport: { width: viewport.width, height: viewport.height },
            }),
          }],
          isError: true,
        };
      }

      const cdpClient = sessionManager.getCDPClient();
      const isStealth = sessionManager.isStealthTarget(tabId);

      const { delta } = await withDomDelta(page, async () => {
        if (isStealth) await humanMouseMove(page, cx, cy);
        await dispatchCoordinateClick(cdpClient, page, {
          x: cx,
          y: cy,
          button: (coordinateArg.button as 'left' | 'right' | 'middle') ?? 'left',
          clickCount: (coordinateArg.clickCount as number) ?? 1,
          modifiers: (coordinateArg.modifiers as Array<'alt' | 'ctrl' | 'meta' | 'shift'>) ?? [],
        });
      }, { settleMs: Math.max(150, waitAfter) });

      const lines: string[] = [`Clicked coordinate (${cx}, ${cy}) via CDP`];
      if (delta) lines.push('', '[DOM Delta]', delta);

      const resultContent: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: lines.join('\n') },
      ];

      if (verifyMode !== 'none') {
        try {
          const screenshotBuf = await withTimeout(
            page.screenshot({ type: 'webp', quality: 60, encoding: 'base64' }),
            DEFAULT_SCREENSHOT_TIMEOUT_MS,
            'verify-screenshot',
            context
          ) as string;
          resultContent.push({ type: 'image' as const, data: screenshotBuf, mimeType: 'image/webp' });
        } catch { /* screenshot failed, non-fatal */ }
      }

      const coordinateResult = { content: resultContent } as MCPResult;
      await appendReturnAfterState(coordinateResult, page, sessionId, tabId, returnAfterState, context);
      return coordinateResult;
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Interact error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  // ─── Mode: ref (default) ───
  if (mode !== 'ref') {
    return {
      content: [{ type: 'text', text: 'INVALID_SCHEMA: mode must be "ref" or "coordinate".' }],
      isError: true,
    };
  }
  if (coordinateArg) {
    return {
      content: [{ type: 'text', text: 'INVALID_SCHEMA: "coordinate" must not be provided when mode is "ref". Use "query", "ref", or "nodeRef" instead.' }],
      isError: true,
    };
  }

  // Either query, ref, or nodeRef must be supplied for mode=ref. ref/nodeRef
  // provide fast paths that skip DOM re-resolution; query falls back to AX → CSS
  // discovery (#831/#844).
  if (!query && !ref && !nodeRefArg) {
    return {
      content: [{ type: 'text', text: 'INVALID_SCHEMA: either "query", "ref", or "nodeRef" is required when mode is "ref".' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'interact');
    if (!page) {
      const available = await sessionManager.getAvailableTargets(sessionId);
      const availableInfo = available.length > 0
        ? `\nAvailable tabs:\n${available.map(t => `  - tabId: ${t.tabId} | ${t.url} | ${t.title}`).join('\n')}`
        : '\nNo tabs available. Call navigate without tabId to create a new tab.';
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.${availableInfo}` }],
        isError: true,
      };
    }

    // ─── Ref Fast-Path (#831) ───
    // When the caller provides an explicit `ref`, skip discovery entirely.
    // A fresh ref → click via cached backendDOMNodeId.
    // A stale/missing ref → STALE_REF (no silent coordinate fallback).
    //
    // Codex P1 (PR #948): the ref path now joins the same response-construction
    // path as the AX/CSS paths so that callers requesting `verify: true` or
    // `returnFormat: 'state_summary' | 'both'` still receive the screenshot /
    // state-summary output. Previously the ref path returned early, dropping
    // verify and returnFormat handling.
    if (ref) {
      const entry = refIdManager.getRef(sessionId, tabId, ref);
      if (!entry || refIdManager.isRefStale(sessionId, tabId, ref)) {
        return {
          content: [{ type: 'text', text: formatStaleRefError(ref) }],
          isError: true,
          error: makeStaleRefError(ref),
        };
      }

      const cdpClientForRef = sessionManager.getCDPClient();
      try {
        try {
          await cdpClientForRef.send(page, 'DOM.scrollIntoViewIfNeeded', {
            backendNodeId: entry.backendDOMNodeId,
          });
          await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));
        } catch {
          // Detached nodes are surfaced as STALE_REF by box-model resolution.
        }

        let rectX = 0, rectY = 0;
        try {
          const { model } = await cdpClientForRef.send<{ model: { content: number[] } }>(
            page, 'DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId }
          );
          if (model?.content && model.content.length >= 8) {
            const bx = model.content[0], by = model.content[1];
            const bw = model.content[2] - bx, bh = model.content[5] - by;
            if (bw > 0 && bh > 0) {
              rectX = Math.round(bx + bw / 2);
              rectY = Math.round(by + bh / 2);
            }
          }
        } catch {
          return {
            content: [{ type: 'text', text: formatStaleRefError(ref) }],
            isError: true,
            error: makeStaleRefError(ref),
          };
        }

        if (rectX === 0 && rectY === 0) {
          return {
            content: [{ type: 'text', text: formatStaleRefError(ref) }],
            isError: true,
            error: makeStaleRefError(ref),
          };
        }

        const isStealthRef = sessionManager.isStealthTarget(tabId);
        const { result: refActionResult, verify: refVerifyReport } = await runVerify(
          page,
          verifyMode,
          async () =>
            withDomDelta(page, async () => {
              if (isStealthRef) await humanMouseMove(page, rectX, rectY);
              if (action === 'double_click') await page.mouse.click(rectX, rectY, { clickCount: 2 });
              else if (action === 'hover') {
                if (!isStealthRef) await page.mouse.move(rectX, rectY);
              } else {
                await page.mouse.click(rectX, rectY);
              }
            }, { settleMs: Math.max(150, waitAfter) }),
        );
        const refDelta = refActionResult.delta;

        invalidateAXCache(getTargetId(page.target()));
        await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

        const refVerb = action === 'double_click' ? 'Double-clicked' : action === 'hover' ? 'Hovered' : 'Clicked';
        const refOutcome = classifyOutcome(refDelta, entry.role);
        const refLabel = `${entry.role}${entry.name ? ` "${entry.name}"` : ''}`;
        const refLine = formatOutcomeLine(refOutcome, refVerb, refLabel, `[${ref}]`, '[via ref]');

        // Build response using the same shared post-action handler as the
        // AX/CSS paths — preserves `verify` and `returnFormat` behavior.
        return await buildPostActionResponse({
          page,
          context,
          headerLine: refLine,
          delta: refDelta,
          returnFormat,
          verify: verifyMode === 'screenshot' || verifyMode === 'both',
          verifyReport: refVerifyReport,
          extraTopLevel: { via: 'ref' },
          sessionId,
          tabId,
          returnAfterState,
        });
      } catch (refErr) {
        throwIfAborted(context);
        console.error(`[interact] ref fast-path failed for ${ref}: ${refErr instanceof Error ? refErr.message : String(refErr)}`);
        return {
          content: [{ type: 'text', text: formatStaleRefError(ref) }],
          isError: true,
          error: makeStaleRefError(ref),
        };
      }
    }

    // ─── nodeRef branch (#844) ───
    // When the caller supplied a stable backend-node uid, resolve it before
    // any element-discovery work. This bypasses CSS/AX scoring entirely and
    // turns interact into a near-pure CDP click. On a uid that the registry
    // no longer knows (because navigation evicted it), we return a
    // structured `uid_evicted` error rather than a generic stale-ref panic
    // — the hint engine recognises that prefix and suppresses its
    // "Refs expire after page changes" hint (see hints/rules/error-recovery.ts).
    if (nodeRefArg) {
      const cdpClientForNodeRef = sessionManager.getCDPClient();
      const resolved = resolveNodeRef(page, nodeRefArg);
      if (!resolved) {
        let currentLoaderId = '';
        try {
          currentLoaderId = await getCurrentLoaderId(page, cdpClientForNodeRef);
        } catch {
          currentLoaderId = '';
        }
        if (!isNodeRefEnabled()) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: nodeRef is not supported when OPENCHROME_NODE_REF is disabled. ${formatNodeRefToken(null)}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: formatUidEvictedError(nodeRefArg, currentLoaderId || 'unknown'),
            },
          ],
          isError: true,
        };
      }

      // Resolve the box model and click via CDP — single round-trip.
      try {
        await cdpClientForNodeRef.send(page, 'DOM.scrollIntoViewIfNeeded', {
          backendNodeId: resolved.backendNodeId,
        });
        await new Promise((r) => setTimeout(r, DEFAULT_DOM_SETTLE_DELAY_MS));
      } catch {
        // continue — click attempt may still succeed
      }
      let cx = 0;
      let cy = 0;
      try {
        const { model } = await cdpClientForNodeRef.send<{ model: { content: number[] } }>(
          page,
          'DOM.getBoxModel',
          { backendNodeId: resolved.backendNodeId },
        );
        if (!model?.content || model.content.length < 8) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: nodeRef ${nodeRefArg} resolved but element has no box model (hidden or detached).`,
              },
            ],
            isError: true,
          };
        }
        const bx = model.content[0];
        const by = model.content[1];
        const bw = model.content[2] - bx;
        const bh = model.content[5] - by;
        cx = Math.round(bx + bw / 2);
        cy = Math.round(by + bh / 2);
      } catch (boxErr) {
        return {
          content: [
            {
              type: 'text',
              text: `nodeRef interact error: getBoxModel failed: ${boxErr instanceof Error ? boxErr.message : String(boxErr)}`,
            },
          ],
          isError: true,
        };
      }

      const isStealthNR = sessionManager.isStealthTarget(tabId);
      const { delta: nrDelta } = await withDomDelta(
        page,
        async () => {
          if (isStealthNR) await humanMouseMove(page, cx, cy);
          if (action === 'double_click') {
            await page.mouse.click(cx, cy, { clickCount: 2 });
          } else if (action === 'hover') {
            if (!isStealthNR) await page.mouse.move(cx, cy);
          } else {
            await page.mouse.click(cx, cy);
          }
        },
        { settleMs: Math.max(150, waitAfter) },
      );

      invalidateAXCache(getTargetId(page.target()));

      const verb =
        action === 'double_click' ? 'Double-clicked' : action === 'hover' ? 'Hovered' : 'Clicked';
      const outcome = classifyOutcome(nrDelta, 'element');
      const refToken = formatNodeRefToken(nodeRefArg);
      const line = formatOutcomeLine(
        outcome,
        verb,
        `element via nodeRef`,
        `[${nodeRefArg}]`,
        `[${refToken}]`,
      );

      const lines: string[] = [line, refToken];
      if (nrDelta) lines.push('', '[DOM Delta]', nrDelta);

      const nodeRefResult = { content: [{ type: 'text', text: lines.join('\n') }] } as MCPResult;
      await appendReturnAfterState(nodeRefResult, page, sessionId, tabId, returnAfterState, context);
      return nodeRefResult;
    }

    const queryString = query as string;
    const queryNorm = normalizeQuery(queryString);
    const queryLower = queryNorm;
    const queryTokens = tokenizeQuery(queryNorm);

    // Optional polling for dynamic/lazy content
    const maxWait = waitForMs ? Math.min(Math.max(waitForMs, 100), 30000) : 0;
    let bestElement: (FoundElement & { _origIdx: number }) | null = null;
    const startTime = Date.now();
    const cdpClient = sessionManager.getCDPClient();

    // ─── AX-First Resolution ───
    // Try AX tree first — the browser's accessibility engine understands all UI frameworks
    try {
      const axMatches = await withTimeout(
        resolveElementsByAXTree(page, cdpClient, queryString, {
          useCenter: true,
          maxResults: 3,
        }),
        10000,
        'ax-resolution',
        context
      );
      if (axMatches.length > 0) {
        const ax = axMatches[0];

        // Scroll into view
        try {
          await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
            backendNodeId: ax.backendDOMNodeId,
          });
          await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));
          // Re-resolve coordinates after scroll
          const { model } = await cdpClient.send<{ model: { content: number[] } }>(
            page, 'DOM.getBoxModel', { backendNodeId: ax.backendDOMNodeId }
          );
          if (model?.content && model.content.length >= 8) {
            const bx = model.content[0], by = model.content[1];
            const bw = model.content[2] - bx, bh = model.content[5] - by;
            if (bw > 0 && bh > 0) {
              ax.rect = { x: bx + bw / 2, y: by + bh / 2, width: bw, height: bh };
            }
          }
        } catch { /* use original coordinates */ }

        const axX = Math.round(ax.rect.x);
        const axY = Math.round(ax.rect.y);

        // Perform action with DOM delta — wrapped in runVerify so the per-action
        // verify report (AX-hash + pHash) is captured around the actual click.
        const isStealth = sessionManager.isStealthTarget(tabId);
        const axGuard = await guardIrreversibleBrowserAction(
          {
            toolName: 'interact',
            action,
            labelText: `${query} ${ax.role} ${ax.name}`,
            pageUrl: page.url(),
          },
          () => runVerify(
            page,
            verifyMode,
            async () =>
              withDomDelta(page, async () => {
                // Stealth: use Bézier curve mouse path to avoid bot detection
                if (isStealth) await humanMouseMove(page, axX, axY);
                if (action === 'double_click') await page.mouse.click(axX, axY, { clickCount: 2 });
                else if (action === 'hover') { if (!isStealth) await page.mouse.move(axX, axY); }
                else await page.mouse.click(axX, axY);
              }, { settleMs: Math.max(150, waitAfter) }),
          ),
        );
        if (axGuard.blocked) return axGuard.blocked;
        const { verify: axVerifyReport, result: axActionResult } = axGuard.value!;
        const axDelta = axActionResult.delta;

        // Invalidate AX cache after interaction
        invalidateAXCache(getTargetId(page.target()));

        // Generate ref
        const axRef = refIdManager.generateRef(
          sessionId, tabId, ax.backendDOMNodeId,
          ax.role, ax.name, undefined, undefined
        );

        // Mint a stable nodeRef (P2: token always present; null when off).
        let axNodeRef: string | null = null;
        try {
          const loaderId = await getCurrentLoaderId(page, cdpClient);
          axNodeRef = mintNodeRefSync(page, loaderId, ax.backendDOMNodeId);
        } catch {
          axNodeRef = null;
        }

        // Clean up any leftover tags
        await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

        // Classify outcome and build response
        const axVerb = action === 'double_click' ? 'Double-clicked' : action === 'hover' ? 'Hovered' : 'Clicked';
        const axOutcome = classifyOutcome(axDelta, ax.role);
        const axLine = formatOutcomeLine(axOutcome, axVerb, `${ax.role} "${ax.name}"`, `[${axRef}]`, `[${MATCH_LEVEL_LABELS[ax.matchLevel]} via AX tree]`);

        // Gather state summary (same as CSS path)
        const axState = await withTimeout(page.evaluate(() => {
          const url = window.location.href;
          const title = document.title;
          const active = document.activeElement;
          let activeInfo = 'none';
          if (active && active !== document.body) {
            const tag = active.tagName.toLowerCase();
            const role = active.getAttribute('role') || tag;
            const name = active.getAttribute('aria-label') || (active as HTMLInputElement).value?.slice(0, 30) || active.textContent?.slice(0, 30) || '';
            activeInfo = `${role}: "${name}"`;
          }
          return { url, title, activeInfo };
        }), 3000, 'state-summary', context).catch(() => ({ url: '', title: '', activeInfo: 'unknown' }));

        const lines: string[] = [axLine, formatNodeRefToken(axNodeRef)];
        if (axDelta) lines.push('', '[DOM Delta]', axDelta);
        if (axState.activeInfo !== 'none') lines.push('', `[Focused] ${axState.activeInfo}`);

        const resultContent: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text' as const, text: lines.join('\n') },
        ];

        // Legacy screenshot content (backcompat for `verify: true` → 'screenshot').
        // Preserved verbatim so callers that accept the WebP image still receive it.
        if (verifyMode === 'screenshot' || verifyMode === 'both') {
          try {
            const screenshotBuf = await withTimeout(
              page.screenshot({ type: 'webp', quality: 60, encoding: 'base64' }),
              DEFAULT_SCREENSHOT_TIMEOUT_MS,
              'verify-screenshot',
              context
            ) as string;
            resultContent.push({ type: 'image' as const, data: screenshotBuf, mimeType: 'image/webp' });
          } catch { /* screenshot failed, non-fatal */ }
        }

        const axResult = attachVerifyReport({ content: resultContent }, axVerifyReport);
        await appendReturnAfterState(axResult, page, sessionId, tabId, returnAfterState, context);
        return axResult;
      }
    } catch (axError) {
      throwIfAborted(context);
      // AX resolution failed — fall through to CSS discovery
      console.error(`[interact] AX resolution failed, falling back to CSS: ${axError instanceof Error ? axError.message : String(axError)}`);
    }

    // Budget check before expensive CSS discovery path
    if (context && !hasBudget(context, 15_000)) {
      return {
        content: [{ type: 'text', text: `interact: deadline approaching — skipped CSS fallback for "${queryString}"` }],
        isError: true,
      };
    }
    // ─── CSS Fallback (existing logic) ───
    do {
    // Find elements matching the query using the shared discovery module
    let results: Omit<FoundElement, 'score'>[];
    const cb = getCircuitBreaker();
    try {
      results = await discoverElements(page, cdpClient, queryLower, {
        maxResults: 30,
        useCenter: true,
        timeout: 10000,
        toolName: 'interact',
        circuitBreaker: {
          check: (_pageUrl: string) => !cb.check(tabId, queryLower).allowed,
          recordFailure: (_pageUrl: string) => cb.recordElementFailure(tabId, queryLower),
          recordSuccess: (_pageUrl: string) => cb.recordElementSuccess(tabId, queryLower),
        },
      });
    } catch {
      throwIfAborted(context);
      // CDP evaluate timed out — retry if budget remains
      if (maxWait > 0 && Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      results = [];
    }

      if (results.length === 0) {
        if (maxWait > 0 && Date.now() - startTime < maxWait) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }
        return {
          content: [{ type: 'text', text: `No elements found matching "${queryString}"` }],
          isError: true,
        };
      }

      // Score and sort, preserving original index for tagged element re-lookup
      const scoredResults: (FoundElement & { _origIdx: number })[] = results
        .map((el, i) => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens), _origIdx: i }))
        .sort((a, b) => b.score - a.score);

      if (scoredResults.length > 0 && scoredResults[0].score >= 10) {
        bestElement = scoredResults[0];
        break;
      }

      if (maxWait > 0 && Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } else {
        // No polling or timeout reached — use best available even if low score
        if (scoredResults.length > 0) {
          bestElement = scoredResults[0];
        }
        break;
      }
    } while (Date.now() - startTime < maxWait);

    const bestMatch = bestElement;

    if (!bestMatch || bestMatch.score < 10) {
      return {
        content: [
          {
            type: 'text',
            text: `No good match found for "${queryString}". Best candidate was "${bestMatch?.name || 'unknown'}" with low confidence.`,
          },
        ],
        isError: true,
      };
    }

    // Scroll into view first if needed
    if (bestMatch.backendDOMNodeId) {
      try {
        await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
          backendNodeId: bestMatch.backendDOMNodeId,
        });
        await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

        // Re-get position after scroll using the shared utility
        const newRect = await getTaggedElementRect(page, cdpClient, DISCOVERY_TAG, bestMatch._origIdx, true);
        if (newRect) {
          bestMatch.rect.x = newRect.x;
          bestMatch.rect.y = newRect.y;
        }
      } catch {
        // Continue with original coordinates
      }
    }

    const finalX = Math.round(bestMatch.rect.x);
    const finalY = Math.round(bestMatch.rect.y);

    // Perform the action with DOM delta capture, wrapped in runVerify so the
    // structured verify report (AX-hash + pHash) covers the actual click.
    const isStealthCSS = sessionManager.isStealthTarget(tabId);
    const cssGuard = await guardIrreversibleBrowserAction(
      {
        toolName: 'interact',
        action,
        labelText: `${query} ${bestMatch.role} ${bestMatch.name} ${bestMatch.textContent ?? ''}`,
        pageUrl: page.url(),
      },
      () => runVerify(
        page,
        verifyMode,
        async () =>
          withDomDelta(
            page,
            async () => {
              // Stealth: use Bézier curve mouse path to avoid bot detection
              if (isStealthCSS) await humanMouseMove(page, finalX, finalY);
              if (action === 'double_click') {
                await page.mouse.click(finalX, finalY, { clickCount: 2 });
              } else if (action === 'hover') {
                if (!isStealthCSS) await page.mouse.move(finalX, finalY);
              } else {
                await page.mouse.click(finalX, finalY);
              }
            },
            { settleMs: Math.max(150, waitAfter) }
          ),
      ),
    );
    if (cssGuard.blocked) return cssGuard.blocked;
    const { result: cssDomResult, verify: cssVerifyReport } = cssGuard.value!;
    const { delta } = cssDomResult;

    // Generate ref for the interacted element
    let refId = '';
    if (bestMatch.backendDOMNodeId) {
      refId = refIdManager.generateRef(
        sessionId,
        tabId,
        bestMatch.backendDOMNodeId,
        bestMatch.role,
        bestMatch.name,
        bestMatch.tagName,
        bestMatch.textContent
      );
    }

    // Mint a stable nodeRef (P2: token always present; null when off).
    let cssNodeRef: string | null = null;
    if (bestMatch.backendDOMNodeId) {
      try {
        const loaderId = await getCurrentLoaderId(page, cdpClient);
        cssNodeRef = mintNodeRefSync(page, loaderId, bestMatch.backendDOMNodeId);
      } catch {
        cssNodeRef = null;
      }
    }

    // Clean up discovery tags to prevent stale properties
    await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

    // Invalidate AX cache after CSS-path interaction too
    invalidateAXCache(getTargetId(page.target()));

    // Build compact action label with confidence score
    const actionVerb = action === 'double_click' ? 'Double-clicked' : action === 'hover' ? 'Hovered' : 'Clicked';
    const textSample = bestMatch.textContent?.slice(0, 50) || bestMatch.name.slice(0, 50);
    const textPart = textSample ? ` "${textSample}"` : '';
    const refPart = refId ? ` [${refId}]` : '';
    const confidencePart = bestMatch.score < 50 ? ` [via CSS, LOW CONFIDENCE]` : ` [via CSS]`;
    const cssOutcome = classifyOutcome(delta, bestMatch.role);
    const interactedLine = formatOutcomeLine(cssOutcome, actionVerb, `${bestMatch.tagName}${textPart}`, refPart, confidencePart);

    // Gather state summary via page.evaluate
    const stateSummary = await withTimeout(page.evaluate(() => {
      const url = window.location.href;
      const title = document.title;
      const scrollX = Math.round(window.scrollX);
      const scrollY = Math.round(window.scrollY);

      // Active element info
      const active = document.activeElement;
      let activeInfo = 'none';
      if (active && active !== document.body) {
        const inputEl = active as HTMLInputElement;
        const role =
          active.getAttribute('role') ||
          (active.tagName === 'BUTTON'
            ? 'button'
            : active.tagName === 'INPUT'
              ? inputEl.type || 'textbox'
              : active.tagName.toLowerCase());
        const name =
          active.getAttribute('aria-label') ||
          active.getAttribute('title') ||
          active.textContent?.trim().slice(0, 40) ||
          '';
        activeInfo = `${role}${name ? ` "${name}"` : ''}`;
      }

      // Visible panel contents (first 80 chars each, max 3)
      const panels: string[] = [];
      const panelSelectors = [
        '[role="tabpanel"]',
        '[role="dialog"]',
        '[role="main"]',
        'main',
        '.panel',
        '[class*="panel"]',
        '[class*="content"]',
      ];
      for (const sel of panelSelectors) {
        if (panels.length >= 3) break;
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (panels.length >= 3) break;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const text = el.textContent?.trim().slice(0, 80) || '';
            if (text.length > 10) {
              panels.push(text);
            }
          }
        } catch {
          // skip bad selectors
        }
      }

      // Visible headings
      const headings: string[] = [];
      for (const hEl of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
        const rect = hEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(hEl);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = hEl.textContent?.trim().slice(0, 60) || '';
        if (text) headings.push(text);
        if (headings.length >= 3) break;
      }

      return { url, title, scrollX, scrollY, activeInfo, panels, headings };
    }), 10000, 'interact', context).catch(() => ({
      url: '', title: '', scrollX: 0, scrollY: 0,
      activeInfo: 'unknown', panels: [] as string[], headings: [] as string[],
    }));

    // Build the response — compact success format
    const lines: string[] = [interactedLine, formatNodeRefToken(cssNodeRef)];

    if (returnFormat === 'dom_delta' || returnFormat === 'both') {
      if (delta) {
        lines.push(delta);
      }
    }

    if (returnFormat === 'state_summary' || returnFormat === 'both') {
      lines.push(
        `[State Summary] url: ${stateSummary.url} | scroll: ${stateSummary.scrollX},${stateSummary.scrollY} | active: ${stateSummary.activeInfo}`
      );

      if (stateSummary.headings.length > 0) {
        lines.push(`[Headings] ${stateSummary.headings.map(h => `"${h}"`).join(' | ')}`);
      }

      if (stateSummary.panels.length > 0) {
        const panelParts = stateSummary.panels.map((p, i) => `Panel ${i + 1}: "${p}"`);
        lines.push(`[Visible] ${panelParts.join(' | ')}`);
      }
    }

    // Optional screenshot verification — WebP via CDP, fallback to Puppeteer PNG.
    // Legacy attachment: only emit the embedded image when the caller asked for
    // a screenshot mode (true → 'screenshot' via coerceVerifyMode, or the new
    // 'screenshot'/'both' enum values). Default 'none' path is unchanged.
    let screenshotContent: { type: 'image'; data: string; mimeType: string } | null = null;
    if (verifyMode === 'screenshot' || verifyMode === 'both') {
      try {
        const screenshotResult = await Promise.race([
          (async () => {
            const cdpSession = await (page as any).target().createCDPSession();
            try {
              const { data } = await cdpSession.send('Page.captureScreenshot', {
                format: 'webp',
                quality: 60,
                optimizeForSpeed: true,
              });
              return { data: data as string, mimeType: 'image/webp' };
            } finally {
              await cdpSession.detach().catch(() => {});
            }
          })(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), DEFAULT_SCREENSHOT_RACE_TIMEOUT_MS)),
        ]);

        if (screenshotResult) {
          screenshotContent = { type: 'image' as const, ...screenshotResult };
        } else {
          throw new Error('CDP screenshot timed out');
        }
      } catch {
        // Fallback to Puppeteer PNG with timeout
        try {
          let fallbackTimer: NodeJS.Timeout;
          const screenshot = await Promise.race([
            page.screenshot({ encoding: 'base64', type: 'png', fullPage: false }).finally(() => clearTimeout(fallbackTimer)),
            new Promise<never>((_, reject) => {
              fallbackTimer = setTimeout(() => reject(new Error('Fallback screenshot timed out')), DEFAULT_SCREENSHOT_TIMEOUT_MS);
            }),
          ]);
          screenshotContent = { type: 'image' as const, data: screenshot as unknown as string, mimeType: 'image/png' };
        } catch {
          // Screenshot failure is non-fatal
        }
      }
    }

    const responseContent: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
      { type: 'text', text: lines.join('\n') },
    ];
    if (screenshotContent) {
      responseContent.push(screenshotContent);
    }

    const cssResult = attachVerifyReport({ content: responseContent }, cssVerifyReport);
    await appendReturnAfterState(cssResult, page, sessionId, tabId, returnAfterState, context);
    return cssResult;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Interact error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerInteractTool(server: MCPServer): void {
  // Snapshot-cache (#879): bump the active frame's docEpoch after a
  // successful interaction so any later read sees a miss.
  const sm = getSessionManager();
  const wrapped = wrapMutatingHandler(handler, (sid, tid) =>
    tid ? sm.getPage(sid, tid, undefined, 'interact') : Promise.resolve(null),
  );
  server.registerTool('interact', wrapped, definition);
}
