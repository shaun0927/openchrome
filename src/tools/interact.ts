/**
 * Interact Tool - Composite tool that finds an element, performs an action,
 * waits for stability, and returns a comprehensive state summary.
 *
 * Reduces multi-step find→click→screenshot sequences to a single call.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withDomDelta } from '../utils/dom-delta';
import { DEFAULT_DOM_SETTLE_DELAY_MS, DEFAULT_SCREENSHOT_RACE_TIMEOUT_MS, DEFAULT_SCREENSHOT_TIMEOUT_MS } from '../config/defaults';
import { FoundElement, scoreElement, tokenizeQuery } from '../utils/element-finder';
import { discoverElements, getTaggedElementRect, cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';
import { withTimeout } from '../utils/with-timeout';
import { resolveElementsByAXTree, invalidateAXCache, MATCH_LEVEL_LABELS } from '../utils/ax-element-resolver';
import { getTargetId } from '../utils/puppeteer-helpers';
import { classifyOutcome, formatOutcomeLine } from '../utils/ralph/outcome-classifier';

const definition: MCPToolDefinition = {
  name: 'interact',
  description: 'Find element, act, wait, return state summary.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      query: {
        type: 'string',
        description: 'Element to act on (natural language)',
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
      verify: {
        type: 'boolean',
        description: 'Return screenshot after action',
      },
      waitForMs: {
        type: 'number',
        description: 'Poll timeout for element in ms. Max: 30000',
      },
      pollInterval: {
        type: 'number',
        description: 'Poll interval in ms. Default: 200',
      },
    },
    required: ['tabId', 'query'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;
  const action = (args.action as string) || 'click';
  const waitAfter = Math.min(Math.max((args.waitAfter as number) || 500, 0), 10000);
  const returnFormat = (args.returnFormat as string) || 'both';
  const verify = args.verify as boolean | undefined;
  const waitForMs = args.waitForMs as number | undefined;
  const pollInterval = Math.min(Math.max((args.pollInterval as number) || 200, 50), 2000);

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!query) {
    return {
      content: [{ type: 'text', text: 'Error: query is required' }],
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

    const queryLower = query.normalize('NFC').toLowerCase().replace(/["""'''`]/g, '');
    const queryTokens = tokenizeQuery(queryLower);

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
        'ax-resolution'
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

        // Perform action with DOM delta
        const { delta: axDelta } = await withDomDelta(page, async () => {
          if (action === 'double_click') await page.mouse.click(axX, axY, { clickCount: 2 });
          else if (action === 'hover') await page.mouse.move(axX, axY);
          else await page.mouse.click(axX, axY);
        }, { settleMs: Math.max(150, waitAfter) });

        // Invalidate AX cache after interaction
        invalidateAXCache(getTargetId(page.target()));

        // Generate ref
        const axRef = refIdManager.generateRef(
          sessionId, tabId, ax.backendDOMNodeId,
          ax.role, ax.name, undefined, undefined
        );

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
        }), 3000, 'state-summary').catch(() => ({ url: '', title: '', activeInfo: 'unknown' }));

        const lines: string[] = [axLine];
        if (axDelta) lines.push('', '[DOM Delta]', axDelta);
        if (axState.activeInfo !== 'none') lines.push('', `[Focused] ${axState.activeInfo}`);

        const resultContent: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text' as const, text: lines.join('\n') },
        ];

        // Optional screenshot (verify mode)
        if (verify) {
          try {
            const screenshotBuf = await withTimeout(
              page.screenshot({ type: 'webp', quality: 60, encoding: 'base64' }),
              DEFAULT_SCREENSHOT_TIMEOUT_MS,
              'verify-screenshot'
            ) as string;
            resultContent.push({ type: 'image' as const, data: screenshotBuf, mimeType: 'image/webp' });
          } catch { /* screenshot failed, non-fatal */ }
        }

        return { content: resultContent };
      }
    } catch (axError) {
      // AX resolution failed — fall through to CSS discovery
      console.error(`[interact] AX resolution failed, falling back to CSS: ${axError instanceof Error ? axError.message : String(axError)}`);
    }

    // ─── CSS Fallback (existing logic) ───
    do {
    // Find elements matching the query using the shared discovery module
    let results: Omit<FoundElement, 'score'>[];
    try {
      results = await discoverElements(page, cdpClient, queryLower, {
        maxResults: 30,
        useCenter: true,
        timeout: 10000,
        toolName: 'interact',
      });
    } catch {
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

    // Perform the action with DOM delta capture
    const { delta } = await withDomDelta(
      page,
      async () => {
        if (action === 'double_click') {
          await page.mouse.click(finalX, finalY, { clickCount: 2 });
        } else if (action === 'hover') {
          await page.mouse.move(finalX, finalY);
        } else {
          await page.mouse.click(finalX, finalY);
        }
      },
      { settleMs: Math.max(150, waitAfter) }
    );

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
    }), 10000, 'interact').catch(() => ({
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

    // Optional screenshot verification — WebP via CDP, fallback to Puppeteer PNG
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

    return {
      content: responseContent,
    };
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
