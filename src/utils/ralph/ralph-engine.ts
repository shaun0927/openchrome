/**
 * Ralph Engine — Never-give-up interaction resilience
 *
 * When one click strategy doesn't work, automatically escalates to the next.
 * 7 strategies, outcome-classified after each attempt, timeout-budgeted.
 *
 * S1 AX tree click      → page.mouse.click at AX-resolved coordinates
 * S2 CSS discovery click → page.mouse.click at CSS-discovered coordinates
 * S3 CDP coordinate      → Input.dispatchMouseEvent (bypasses isTrusted)
 * S4 JS injection        → element.click() + dispatchEvent
 * S5 Keyboard navigation → DOM.focus + keyboard.press('Enter'/'Space')
 * S6 CDP raw events      → Full mousePressed + mouseReleased sequence
 * S7 HITL               → Return structured context for human intervention
 */

import type { Page } from 'puppeteer-core';
import type { CDPClient } from '../../cdp/client';
import { withDomDelta } from '../dom-delta';
import { resolveElementsByAXTree, invalidateAXCache, MATCH_LEVEL_LABELS, AXResolvedElement } from '../ax-element-resolver';
import { discoverElements, cleanupTags, DISCOVERY_TAG, getTaggedElementRect } from '../element-discovery';
import { FoundElement, scoreElement, tokenizeQuery } from '../element-finder';
import { classifyOutcome, formatOutcomeLine, InteractionOutcome } from './outcome-classifier';
import { getTargetId } from '../puppeteer-helpers';
import { DEFAULT_DOM_SETTLE_DELAY_MS } from '../../config/defaults';

// ─── Types ───

export type StrategyId = 'S1_AX' | 'S2_CSS' | 'S3_CDP_COORD' | 'S4_JS_INJECT' | 'S5_KEYBOARD' | 'S6_CDP_RAW' | 'S7_HITL';

export interface RalphResult {
  success: boolean;
  outcome: InteractionOutcome;
  strategyUsed: StrategyId;
  strategiesTried: StrategyId[];
  responseLine: string;
  delta?: string;
  backendDOMNodeId?: number;
  role?: string;
  name?: string;
  hitlRequired?: boolean;
}

export interface RalphOptions {
  action?: 'click' | 'double_click' | 'hover';
  waitAfter?: number;
  /** Maximum total time for all strategies in ms (default: 15000) */
  budgetMs?: number;
}

// ─── Strategy Implementations ───

interface StrategyContext {
  page: Page;
  cdpClient: CDPClient;
  query: string;
  action: 'click' | 'double_click' | 'hover';
  waitAfter: number;
}

interface StrategyResult {
  delta?: string;
  backendDOMNodeId?: number;
  role?: string;
  name?: string;
  elementDesc: string;
  refInfo: string;
  sourceInfo: string;
}

type StrategyFn = (ctx: StrategyContext) => Promise<StrategyResult | null>;

/** S1: AX tree resolution + page.mouse.click */
const strategyAX: StrategyFn = async (ctx) => {
  const axMatches = await resolveElementsByAXTree(ctx.page, ctx.cdpClient, ctx.query, {
    useCenter: true, maxResults: 3,
  });
  if (axMatches.length === 0) return null;
  const ax = axMatches[0];

  // Scroll + re-resolve
  await scrollAndResolve(ctx.page, ctx.cdpClient, ax);
  const x = Math.round(ax.rect.x), y = Math.round(ax.rect.y);

  const { delta } = await performAction(ctx.page, ctx.action, x, y, ctx.waitAfter);
  invalidateAXCache(getTargetId(ctx.page.target()));

  return {
    delta,
    backendDOMNodeId: ax.backendDOMNodeId,
    role: ax.role,
    name: ax.name,
    elementDesc: `${ax.role} "${ax.name}"`,
    refInfo: '',
    sourceInfo: `[${MATCH_LEVEL_LABELS[ax.matchLevel]} via AX tree]`,
  };
};

/** S2: CSS discovery + page.mouse.click */
const strategyCSS: StrategyFn = async (ctx) => {
  const queryLower = ctx.query.toLowerCase();
  const queryTokens = tokenizeQuery(ctx.query);

  let results: Omit<FoundElement, 'score'>[];
  try {
    results = await discoverElements(ctx.page, ctx.cdpClient, queryLower, {
      maxResults: 30, useCenter: true, timeout: 5000, toolName: 'ralph',
    });
  } catch { return null; }

  if (results.length === 0) return null;

  const scored = results
    .map((el, i) => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens), _origIdx: i }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0 || scored[0].score < 10) return null;
  const best = scored[0];

  // Scroll
  if (best.backendDOMNodeId) {
    try {
      await ctx.cdpClient.send(ctx.page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: best.backendDOMNodeId });
      await new Promise(r => setTimeout(r, DEFAULT_DOM_SETTLE_DELAY_MS));
      const rect = await getTaggedElementRect(ctx.page, ctx.cdpClient, DISCOVERY_TAG, best._origIdx, true);
      if (rect) { best.rect.x = rect.x; best.rect.y = rect.y; }
    } catch { /* use original */ }
  }

  const x = Math.round(best.rect.x), y = Math.round(best.rect.y);
  const { delta } = await performAction(ctx.page, ctx.action, x, y, ctx.waitAfter);
  await cleanupTags(ctx.page, DISCOVERY_TAG).catch(() => {});
  invalidateAXCache(getTargetId(ctx.page.target()));

  const textSample = best.textContent?.slice(0, 50) || best.name.slice(0, 50);
  return {
    delta,
    backendDOMNodeId: best.backendDOMNodeId,
    role: best.role,
    name: best.name,
    elementDesc: `${best.tagName} "${textSample}"`,
    refInfo: '',
    sourceInfo: best.score < 50 ? '[via CSS, LOW CONFIDENCE]' : '[via CSS]',
  };
};

/** S3: CDP Input.dispatchMouseEvent (bypasses Puppeteer's isTrusted handling) */
const strategyCDPCoord: StrategyFn = async (ctx) => {
  // Re-use AX resolution for coordinates but deliver via CDP
  const axMatches = await resolveElementsByAXTree(ctx.page, ctx.cdpClient, ctx.query, {
    useCenter: true, maxResults: 1,
  });
  if (axMatches.length === 0) return null;
  const ax = axMatches[0];

  await scrollAndResolve(ctx.page, ctx.cdpClient, ax);
  const x = Math.round(ax.rect.x), y = Math.round(ax.rect.y);

  const { delta } = await withDomDelta(ctx.page, async () => {
    await ctx.cdpClient.send(ctx.page, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await ctx.cdpClient.send(ctx.page, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
  }, { settleMs: Math.max(150, ctx.waitAfter) });

  invalidateAXCache(getTargetId(ctx.page.target()));

  return {
    delta,
    backendDOMNodeId: ax.backendDOMNodeId,
    role: ax.role,
    name: ax.name,
    elementDesc: `${ax.role} "${ax.name}"`,
    refInfo: '',
    sourceInfo: '[via CDP coordinates]',
  };
};

/** S4: JavaScript injection — element.click() + dispatchEvent */
const strategyJSInject: StrategyFn = async (ctx) => {
  const axMatches = await resolveElementsByAXTree(ctx.page, ctx.cdpClient, ctx.query, {
    useCenter: true, maxResults: 1,
  });
  if (axMatches.length === 0) return null;
  const ax = axMatches[0];

  const { delta } = await withDomDelta(ctx.page, async () => {
    await ctx.cdpClient.send(ctx.page, 'DOM.resolveNode', {
      backendNodeId: ax.backendDOMNodeId,
    }).then(async (result: any) => {
      const objectId = result.object?.objectId;
      if (!objectId) return;
      await ctx.cdpClient.send(ctx.page, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center' });
          this.focus();
          this.click();
          this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }`,
      });
    });
  }, { settleMs: Math.max(150, ctx.waitAfter) });

  invalidateAXCache(getTargetId(ctx.page.target()));

  return {
    delta,
    backendDOMNodeId: ax.backendDOMNodeId,
    role: ax.role,
    name: ax.name,
    elementDesc: `${ax.role} "${ax.name}"`,
    refInfo: '',
    sourceInfo: '[via JS injection]',
  };
};

/** S5: Keyboard navigation — DOM.focus + Enter/Space */
const strategyKeyboard: StrategyFn = async (ctx) => {
  if (ctx.action === 'hover') return null; // keyboard can't hover

  const axMatches = await resolveElementsByAXTree(ctx.page, ctx.cdpClient, ctx.query, {
    useCenter: true, maxResults: 1,
  });
  if (axMatches.length === 0) return null;
  const ax = axMatches[0];

  const { delta } = await withDomDelta(ctx.page, async () => {
    await ctx.cdpClient.send(ctx.page, 'DOM.focus', {
      backendNodeId: ax.backendDOMNodeId,
    });
    await new Promise(r => setTimeout(r, 100));
    // Radio/checkbox respond to Space, buttons to Enter
    const key = ['radio', 'checkbox', 'switch'].includes(ax.role.toLowerCase()) ? 'Space' : 'Enter';
    await ctx.page.keyboard.press(key);
  }, { settleMs: Math.max(150, ctx.waitAfter) });

  invalidateAXCache(getTargetId(ctx.page.target()));

  return {
    delta,
    backendDOMNodeId: ax.backendDOMNodeId,
    role: ax.role,
    name: ax.name,
    elementDesc: `${ax.role} "${ax.name}"`,
    refInfo: '',
    sourceInfo: '[via keyboard]',
  };
};

/** S6: CDP raw mouse event sequence (mouseDown + mouseMove + mouseUp) */
const strategyCDPRaw: StrategyFn = async (ctx) => {
  const axMatches = await resolveElementsByAXTree(ctx.page, ctx.cdpClient, ctx.query, {
    useCenter: true, maxResults: 1,
  });
  if (axMatches.length === 0) return null;
  const ax = axMatches[0];

  await scrollAndResolve(ctx.page, ctx.cdpClient, ax);
  const x = Math.round(ax.rect.x), y = Math.round(ax.rect.y);

  const { delta } = await withDomDelta(ctx.page, async () => {
    // Full mouse sequence: move → down → up
    await ctx.cdpClient.send(ctx.page, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await new Promise(r => setTimeout(r, 50));
    await ctx.cdpClient.send(ctx.page, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await new Promise(r => setTimeout(r, 50));
    await ctx.cdpClient.send(ctx.page, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
  }, { settleMs: Math.max(150, ctx.waitAfter) });

  invalidateAXCache(getTargetId(ctx.page.target()));

  return {
    delta,
    backendDOMNodeId: ax.backendDOMNodeId,
    role: ax.role,
    name: ax.name,
    elementDesc: `${ax.role} "${ax.name}"`,
    refInfo: '',
    sourceInfo: '[via CDP raw events]',
  };
};

// ─── Strategy Registry ───

const STRATEGIES: Array<{ id: StrategyId; fn: StrategyFn; label: string }> = [
  { id: 'S1_AX', fn: strategyAX, label: 'AX tree' },
  { id: 'S2_CSS', fn: strategyCSS, label: 'CSS discovery' },
  { id: 'S3_CDP_COORD', fn: strategyCDPCoord, label: 'CDP coordinates' },
  { id: 'S4_JS_INJECT', fn: strategyJSInject, label: 'JS injection' },
  { id: 'S5_KEYBOARD', fn: strategyKeyboard, label: 'Keyboard' },
  { id: 'S6_CDP_RAW', fn: strategyCDPRaw, label: 'CDP raw events' },
];

// ─── Helpers ───

async function scrollAndResolve(page: Page, cdpClient: CDPClient, ax: AXResolvedElement): Promise<void> {
  try {
    await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: ax.backendDOMNodeId });
    await new Promise(r => setTimeout(r, DEFAULT_DOM_SETTLE_DELAY_MS));
    const { model } = await cdpClient.send<{ model: { content: number[] } }>(
      page, 'DOM.getBoxModel', { backendNodeId: ax.backendDOMNodeId }
    );
    if (model?.content && model.content.length >= 8) {
      const bx = model.content[0], by = model.content[1];
      const bw = model.content[2] - bx, bh = model.content[5] - by;
      if (bw > 0 && bh > 0) ax.rect = { x: bx + bw / 2, y: by + bh / 2, width: bw, height: bh };
    }
  } catch { /* use original coords */ }
}

async function performAction(
  page: Page, action: string, x: number, y: number, waitAfter: number
): Promise<{ delta: string | undefined }> {
  return withDomDelta(page, async () => {
    if (action === 'double_click') await page.mouse.click(x, y, { clickCount: 2 });
    else if (action === 'hover') await page.mouse.move(x, y);
    else await page.mouse.click(x, y);
  }, { settleMs: Math.max(150, waitAfter) });
}

// ─── Main Engine ───

/**
 * Ralph Click — tries up to 7 strategies to interact with an element.
 *
 * Each strategy is tried in order. After each attempt, the Outcome Classifier
 * determines what happened:
 * - SUCCESS → stop, return result
 * - SILENT_CLICK → same element, try next delivery method
 * - WRONG_ELEMENT → try next delivery method
 * - EXCEPTION → try next delivery method
 *
 * If all 6 automated strategies fail, returns HITL context (S7).
 */
export async function ralphClick(
  page: Page,
  cdpClient: CDPClient,
  query: string,
  options?: RalphOptions,
): Promise<RalphResult> {
  const action = options?.action || 'click';
  const waitAfter = options?.waitAfter || 300;
  const budgetMs = options?.budgetMs || 15000;
  const startTime = Date.now();

  const ctx: StrategyContext = { page, cdpClient, query, action, waitAfter };
  const strategiesTried: StrategyId[] = [];

  for (const strategy of STRATEGIES) {
    // Check timeout budget
    if (Date.now() - startTime > budgetMs) {
      break;
    }

    strategiesTried.push(strategy.id);

    try {
      const result = await strategy.fn(ctx);

      if (!result) {
        // Strategy couldn't find/resolve element — try next
        continue;
      }

      const outcome = classifyOutcome(result.delta, result.role);

      if (outcome === 'SUCCESS') {
        const line = formatOutcomeLine(outcome, getVerb(action), result.elementDesc, result.refInfo, result.sourceInfo);
        return {
          success: true,
          outcome,
          strategyUsed: strategy.id,
          strategiesTried,
          responseLine: line,
          delta: result.delta,
          backendDOMNodeId: result.backendDOMNodeId,
          role: result.role,
          name: result.name,
        };
      }

      // SILENT_CLICK or WRONG_ELEMENT — try next strategy
      // (outcome is not SUCCESS, continue waterfall)

    } catch {
      // Strategy threw — try next
      continue;
    }
  }

  // S7: All automated strategies exhausted — HITL
  strategiesTried.push('S7_HITL');
  const triedSummary = strategiesTried.filter(s => s !== 'S7_HITL').map(s => {
    const strat = STRATEGIES.find(st => st.id === s);
    return strat ? strat.label : s;
  }).join(', ');

  const hitlLine = `\u26a0 All ${STRATEGIES.length} strategies exhausted for "${query}". Tried: ${triedSummary}. Please interact with the element manually, or try a different approach (javascript_tool, navigate to a different URL).`;

  return {
    success: false,
    outcome: 'ELEMENT_NOT_FOUND',
    strategyUsed: 'S7_HITL',
    strategiesTried,
    responseLine: hitlLine,
    hitlRequired: true,
  };
}

function getVerb(action: string): string {
  if (action === 'double_click') return 'Double-clicked';
  if (action === 'hover') return 'Hovered';
  return 'Clicked';
}
