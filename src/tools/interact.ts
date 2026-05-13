/**
 * Interact Tool - Composite tool that finds an element, performs an action,
 * waits for stability, and returns a comprehensive state summary.
 *
 * Reduces multi-step find→click→screenshot sequences to a single call.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget, throwIfAborted } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
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
import { dispatchCoordinateClick } from '../cdp/input';
import { coerceVerifyMode, runVerify, VERIFY_FIELD_SCHEMA, VerifyReport } from '../core/perception/verify';
import {
  getLocatorFallbackProvider,
  isLocatorFallbackEnabled,
  locatorFallbackThreshold,
  resolveLocatorFallback,
  type LocatorFallbackCandidate,
  type LocatorFallbackTrigger,
  type ValidatedLocatorFallbackCandidate,
} from '../core/perception/locator-fallback';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { captureBackendNodeReplayStep, shouldCaptureReplayArtifact } from './_shared/replay-recorder';

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
  description: 'Find element by natural language; click/hover/double_click it; wait for DOM settle; return state.\n\nWhen to use: One described element action, with coordinate fallback for Shadow DOM/canvas/iframes.\nWhen NOT to use: Use act for multi-step flows; computer for general coordinate clicks.',
  annotations: TOOL_ANNOTATIONS.interact,
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
      ref: {
        type: 'string',
        description: 'Snapshot ref ID (from read_page refs map). When provided, skips AX re-resolution and clicks the element directly via its cached backendDOMNodeId.',
      },
      intent: {
        type: 'string',
        maxLength: 120,
        description: 'Optional short label (≤120 chars) describing the user-facing goal of this action, e.g. "submit login form". Recorded in the task journal for observability.',
      },
      capture_artifact: {
        type: 'boolean',
        default: false,
        description: 'When true, stage a replay artifact step for oc_skill_record after a successful click. Default false is a strict no-op.',
      },
      locatorFallback: {
        type: 'object',
        description: 'Opt-in AI locator fallback extension point. Disabled by default; when enabled, provider candidates are validated before any action.',
        properties: {
          enabled: { type: 'boolean', description: 'Enable locator fallback for stale/missing/ambiguous targets.' },
          minConfidence: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum provider confidence before validation. Default: 0.7.' },
        },
      },
    },
    required: ['tabId'],
  },
};

async function validateBackendNodeClickability(
  page: any,
  backendNodeId: number,
  cdpClient: { send: (page: any, method: string, params?: Record<string, unknown>) => Promise<unknown> },
): Promise<boolean> {
  const resolved = await cdpClient.send(page, 'DOM.resolveNode', { backendNodeId }) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) return false;

  const checked = await cdpClient.send(page, 'Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      if (!(this instanceof HTMLElement)) return { clickable: false };
      const box = this.getBoundingClientRect();
      const style = window.getComputedStyle(this);
      const disabled = this.disabled === true || this.getAttribute('aria-disabled') === 'true';
      const visible = box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      return { clickable: visible && !disabled };
    }`,
  }) as { result?: { value?: { clickable?: boolean } } };
  return checked.result?.value?.clickable === true;
}

async function validateLocatorCandidate(
  page: any,
  candidate: LocatorFallbackCandidate,
  resolveBackendNodeId?: (ref: string) => number | undefined,
  cdpClient?: { send: (page: any, method: string, params?: Record<string, unknown>) => Promise<unknown> },
): Promise<ValidatedLocatorFallbackCandidate | null> {
  const backendNodeId = candidate.backendNodeId ?? (candidate.ref ? resolveBackendNodeId?.(candidate.ref) : undefined);
  if (typeof backendNodeId === 'number' && cdpClient) {
    try {
      await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
      if (!(await validateBackendNodeClickability(page, backendNodeId, cdpClient))) {
        throw new Error('backend node is not clickable');
      }
      const boxModel = await cdpClient.send(page, 'DOM.getBoxModel', { backendNodeId }) as { model?: { content?: number[] } };
      const content = boxModel.model?.content;
      if (!content || content.length < 8) throw new Error('invalid box model');
      const [x1, y1,, , x2,, , y2] = content;
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      if (width <= 0 || height <= 0) throw new Error('invalid box dimensions');
      return {
        ...candidate,
        selector: candidate.selector ?? candidate.ref ?? `backendNodeId:${backendNodeId}`,
        backendNodeId,
        rect: { x: (x1 + x2) / 2, y: (y1 + y2) / 2, width, height },
      };
    } catch {
      // Fall through to selector validation when a provider supplied both selector and backendNodeId.
    }
  }

  if (!candidate.selector) return null;
  const rect = await page.evaluate((selector: string) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    const disabled = (el as HTMLButtonElement | HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
    if (!visible || disabled) return null;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height };
  }, candidate.selector).catch(() => null);
  if (!rect) return null;
  return { ...candidate, selector: candidate.selector, rect };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  throwIfAborted(context);
  const tabId = args.tabId as string;
  const mode = (args.mode as string) || 'ref';
  const query = args.query as string;
  const coordinateArg = args.coordinate as Record<string, unknown> | undefined;
  const action = (args.action as string) || 'click';
  const waitAfter = Math.min(Math.max((args.waitAfter as number) || 500, 0), 10000);
  const returnFormat = (args.returnFormat as string) || 'both';
  const verifyMode = coerceVerifyMode(args.verify);
  const waitForMs = args.waitForMs as number | undefined;
  const pollInterval = Math.min(Math.max((args.pollInterval as number) || 200, 50), 2000);
  const locatorFallbackArg = args.locatorFallback;
  const locatorFallbackEnabled = isLocatorFallbackEnabled(locatorFallbackArg);
  const locatorMinConfidence = locatorFallbackThreshold(locatorFallbackArg);

  const intent = args.intent as string | undefined;
  const refArg = args.ref as string | undefined;
  const captureArtifact = shouldCaptureReplayArtifact(args.capture_artifact);

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  const runLocatorFallbackForPage = async (page: any, trigger: LocatorFallbackTrigger): Promise<MCPResult | null> => {
    if (!locatorFallbackEnabled || !query) return null;
    const pageInfo = await page.evaluate(() => ({ url: window.location.href, title: document.title })).catch(() => ({ url: '', title: '' }));
    const cdpClient = sessionManager.getCDPClient();
    const resolved = await resolveLocatorFallback(
      { trigger, query, action, tabId, sessionId, pageUrl: pageInfo.url, pageTitle: pageInfo.title, maxCandidates: 5 },
      (candidate) => validateLocatorCandidate(
        page,
        candidate,
        (ref) => refIdManager.getBackendDOMNodeId(sessionId, tabId, ref),
        cdpClient,
      ),
      { minConfidence: locatorMinConfidence, provider: getLocatorFallbackProvider() },
    );
    if (!resolved.accepted) {
      return {
        content: [{ type: 'text', text: `Locator fallback (${resolved.provider}) found no validated candidate for "${query}".` }],
        isError: true,
        locatorFallback: { trigger, provider: resolved.provider, accepted: false },
      } as MCPResult;
    }
    const candidate = resolved.accepted;
    const x = Math.round(candidate.rect.x);
    const y = Math.round(candidate.rect.y);
    const isStealthFallback = sessionManager.isStealthTarget(tabId);
    const { result: fallbackDomResult, verify: fallbackVerifyReport } = await runVerify(
      page,
      verifyMode,
      async () =>
        withDomDelta(page, async () => {
          if (isStealthFallback) await humanMouseMove(page, x, y);
          if (action === 'double_click') await page.mouse.click(x, y, { clickCount: 2 });
          else if (action === 'hover') { if (!isStealthFallback) await page.mouse.move(x, y); }
          else await page.mouse.click(x, y);
        }, { settleMs: Math.max(150, waitAfter) }),
    );
    invalidateAXCache(getTargetId(page.target()));
    const verb = action === 'double_click' ? 'Double-clicked' : action === 'hover' ? 'Hovered' : 'Clicked';
    const lines = [`${verb} locator fallback candidate "${candidate.label ?? candidate.selector}" [provider=${candidate.provider} confidence=${candidate.confidence}]`];
    if (fallbackDomResult.delta) lines.push('', '[DOM Delta]', fallbackDomResult.delta);
    return attachVerifyReport({
      content: [{ type: 'text', text: lines.join('\n') }],
      locatorFallback: {
        trigger,
        provider: resolved.provider,
        accepted: true,
        selected: { selector: candidate.selector, confidence: candidate.confidence, reason: candidate.reason, provider: candidate.provider },
      },
    } as MCPResult, fallbackVerifyReport);
  };

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  // ─── intent validation (#894) ───
  if (intent !== undefined) {
    if (typeof intent !== 'string' || intent.trim() === '') {
      return {
        content: [{ type: 'text', text: 'INVALID_INTENT: intent must be a non-empty string with at most 120 characters.' }],
        isError: true,
      };
    }
    if (intent.length > 120) {
      return {
        content: [{ type: 'text', text: 'INVALID_INTENT: intent must be at most 120 characters.' }],
        isError: true,
      };
    }
  }

  // ─── Ref fast-path (#831) ───
  if (refArg) {
    // Check if the ref is stale (missing or TTL-expired).
    if (refIdManager.isRefStale(sessionId, tabId, refArg)) {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, 'interact').catch(() => null);
      if (page) {
        try {
          const fallback = await runLocatorFallbackForPage(page, 'STALE_REF');
          if (fallback && (fallback as MCPResult & { locatorFallback?: { accepted?: boolean } }).locatorFallback?.accepted === true) return fallback;
        } catch {
          // Preserve the STALE_REF contract when the optional fallback provider itself fails.
        }
      }
      const staleWarning = typeof refIdManager.getRefStalenessWarning === 'function'
        ? refIdManager.getRefStalenessWarning(sessionId, tabId, refArg)
        : undefined;
      const warningText = staleWarning
        ? `\nWarning: ${staleWarning.code}: ${staleWarning.message}`
        : '';
      return {
        content: [{ type: 'text', text: `STALE_REF: ref "${refArg}" is no longer valid (element may have changed or page navigated). Call read_page to get fresh refs.${warningText}` }],
        isError: true,
        error: { code: 'STALE_REF', ref_id: refArg, stale_warning: staleWarning },
      } as MCPResult;
    }

    const backendDOMNodeId = refIdManager.getBackendDOMNodeId(sessionId, tabId, refArg);
    if (!backendDOMNodeId) {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, 'interact').catch(() => null);
      if (page) {
        try {
          const fallback = await runLocatorFallbackForPage(page, 'STALE_REF');
          if (fallback && (fallback as MCPResult & { locatorFallback?: { accepted?: boolean } }).locatorFallback?.accepted === true) return fallback;
        } catch {
          // Preserve the STALE_REF contract when the optional fallback provider itself fails.
        }
      }
      return {
        content: [{ type: 'text', text: `STALE_REF: ref "${refArg}" could not be resolved to a DOM node.` }],
        isError: true,
        error: { code: 'STALE_REF', ref_id: refArg },
      } as MCPResult;
    }

    try {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, 'interact');
      if (!page) {
        return {
          content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.` }],
          isError: true,
        };
      }

      const cdpClient = sessionManager.getCDPClient();
      // Scroll into view then get bounding box
      await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backendDOMNodeId });
      const boxModel = await cdpClient.send(page, 'DOM.getBoxModel', { backendNodeId: backendDOMNodeId }) as
        { model: { content: number[] } };
      const [x1, y1,, , x2,, , y2] = boxModel.model.content;
      const cx = Math.round((x1 + x2) / 2);
      const cy = Math.round((y1 + y2) / 2);

      if (action === 'double_click') {
        await page.mouse.click(cx, cy, { clickCount: 2 });
      } else if (action === 'hover') {
        await page.mouse.move(cx, cy);
      } else {
        await page.mouse.click(cx, cy);
      }

      if (captureArtifact && action === 'click') {
        await captureBackendNodeReplayStep({
          cdpClient,
          page,
          backendNodeId: backendDOMNodeId,
          kind: 'click',
        });
      }

      const actionVerb = action === 'double_click' ? 'Double-clicked' : action === 'hover' ? 'Hovered' : 'Clicked';
      const lines = [`${actionVerb} [${refArg}] [via ref]`];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        via: 'ref',
      } as MCPResult;
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Interact error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  // ─── Mode: coordinate ───
  if (mode === 'coordinate') {
    if (query) {
      return {
        content: [{ type: 'text', text: 'INVALID_SCHEMA: "query" must not be provided when mode is "coordinate". Use "coordinate" block instead.' }],
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

      return { content: resultContent };
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
      content: [{ type: 'text', text: 'INVALID_SCHEMA: "coordinate" must not be provided when mode is "ref". Use "query" instead.' }],
      isError: true,
    };
  }

  if (!query) {
    return {
      content: [{ type: 'text', text: 'INVALID_SCHEMA: "query" is required when mode is "ref".' }],
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

    const queryNorm = normalizeQuery(query);
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
        resolveElementsByAXTree(page, cdpClient, query, {
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
        const { verify: axVerifyReport, result: axActionResult } = await runVerify(
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
        );
        const axDelta = axActionResult.delta;

        // Invalidate AX cache after interaction
        invalidateAXCache(getTargetId(page.target()));

        // Generate ref
        const axRef = refIdManager.generateRef(
          sessionId, tabId, ax.backendDOMNodeId,
          ax.role, ax.name, undefined, undefined
        );

        if (captureArtifact && action === 'click') {
          await captureBackendNodeReplayStep({
            cdpClient,
            page,
            backendNodeId: ax.backendDOMNodeId,
            kind: 'click',
          });
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

        const lines: string[] = [axLine];
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

        return attachVerifyReport({ content: resultContent }, axVerifyReport);
      }
    } catch (axError) {
      throwIfAborted(context);
      // AX resolution failed — fall through to CSS discovery
      console.error(`[interact] AX resolution failed, falling back to CSS: ${axError instanceof Error ? axError.message : String(axError)}`);
    }

    // Budget check before expensive CSS discovery path
    if (context && !hasBudget(context, 15_000)) {
      return {
        content: [{ type: 'text', text: `interact: deadline approaching — skipped CSS fallback for "${query}"` }],
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
        let fallback: MCPResult | null = null;
        if (locatorFallbackEnabled) {
          try {
            fallback = await runLocatorFallbackForPage(page, 'ELEMENT_NOT_FOUND');
          } catch {
            fallback = null;
          }
        }
        if (fallback) return fallback;
        return {
          content: [{ type: 'text', text: `No elements found matching "${query}"` }],
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
      let fallback: MCPResult | null = null;
      if (locatorFallbackEnabled) {
        try {
          fallback = await runLocatorFallbackForPage(page, 'AMBIGUOUS_SELECTOR');
        } catch {
          fallback = null;
        }
      }
      if (fallback) return fallback;
      return {
        content: [
          {
            type: 'text',
            text: `No good match found for "${query}". Best candidate was "${bestMatch?.name || 'unknown'}" with low confidence.`,
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
    const { result: cssDomResult, verify: cssVerifyReport } = await runVerify(
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
    );
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

    if (captureArtifact && action === 'click' && bestMatch.backendDOMNodeId) {
      await captureBackendNodeReplayStep({
        cdpClient,
        page,
        backendNodeId: bestMatch.backendDOMNodeId,
        kind: 'click',
      });
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
    const lines: string[] = [interactedLine];

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

    return attachVerifyReport({ content: responseContent }, cssVerifyReport);
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
  server.registerTool('interact', handler, definition);
}
