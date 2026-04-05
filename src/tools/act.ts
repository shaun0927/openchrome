/**
 * Act Tool - Execute multi-step browser actions from a natural language instruction.
 *
 * Parses the instruction into a structured action sequence (no LLM calls) and
 * executes each step sequentially, reporting per-step outcomes.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withDomDelta } from '../utils/dom-delta';
import { DEFAULT_DOM_SETTLE_DELAY_MS } from '../config/defaults';
import { normalizeQuery } from '../utils/element-finder';
import { resolveElementsByAXTree, invalidateAXCache, AXResolvedElement } from '../utils/ax-element-resolver';
import { getTargetId } from '../utils/puppeteer-helpers';
import { classifyOutcome, formatOutcomeLine } from '../utils/ralph/outcome-classifier';
import { humanMouseMove, humanType } from '../stealth/human-behavior';
import { withTimeout } from '../utils/with-timeout';
import { cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';
import { parseInstruction, ParsedAction } from '../actions/action-parser';
import { matchTemplate } from '../actions/action-templates';
import { getCachedSequence, cacheSequence, validateCachedSequence } from '../actions/action-cache';

// ─── Types ───

interface StepResult {
  step: number;
  action: string;
  target?: string;
  outcome: string;
  delta?: string;
  message?: string;
  error?: string;
}

// ─── Tool Definition ───

const definition: MCPToolDefinition = {
  name: 'act',
  description: 'Execute multi-step browser actions from natural language instruction.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      instruction: {
        type: 'string',
        description: 'Natural language description of actions (e.g., "click login, type admin in username, click submit")',
      },
      context: {
        type: 'string',
        description: 'Additional context (e.g., "on the login page")',
      },
      verify: {
        type: 'boolean',
        description: 'Verify outcome after execution. Default: true',
      },
      timeout: {
        type: 'number',
        description: 'Max time in ms for entire sequence. Default: 30000',
      },
    },
    required: ['tabId', 'instruction'],
  },
};

// ─── Element resolution helper ───

/**
 * Resolve element coordinates via AX tree. Returns null if resolution fails.
 */
async function resolveElement(
  page: Parameters<typeof resolveElementsByAXTree>[0],
  cdpClient: Parameters<typeof resolveElementsByAXTree>[1],
  query: string,
  context?: ToolContext
): Promise<AXResolvedElement | null> {
  try {
    const matches = await withTimeout(
      resolveElementsByAXTree(page, cdpClient, normalizeQuery(query), { useCenter: true, maxResults: 3 }),
      8000,
      'ax-resolution',
      context
    );
    if (matches.length === 0) return null;

    const ax = matches[0];

    // Scroll into view and re-resolve coordinates
    try {
      await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
        backendNodeId: ax.backendDOMNodeId,
      });
      await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

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

    return ax;
  } catch {
    return null;
  }
}

// ─── Step executors ───

async function executeClick(
  page: any,
  cdpClient: any,
  sessionId: string,
  tabId: string,
  parsedAction: ParsedAction,
  stepIndex: number,
  isStealth: boolean,
  context?: ToolContext
): Promise<StepResult> {
  const target = parsedAction.target;
  if (!target) {
    return { step: stepIndex, action: 'click', outcome: 'ELEMENT_NOT_FOUND', error: 'No target specified for click' };
  }

  const el = await resolveElement(page, cdpClient, target, context);
  if (!el) {
    return { step: stepIndex, action: 'click', target, outcome: 'ELEMENT_NOT_FOUND', error: `Could not find "${target}"` };
  }

  const x = Math.round(el.rect.x);
  const y = Math.round(el.rect.y);

  const { delta } = await withDomDelta(page, async () => {
    if (isStealth) await humanMouseMove(page, x, y);
    await page.mouse.click(x, y);
  }, { settleMs: 300 });

  invalidateAXCache(getTargetId(page.target()));

  const refIdManager = getRefIdManager();
  const ref = refIdManager.generateRef(sessionId, tabId, el.backendDOMNodeId, el.role, el.name);
  const outcome = classifyOutcome(delta, el.role);
  const line = formatOutcomeLine(outcome, 'Clicked', `${el.role} "${el.name}"`, `[${ref}]`, '[via AX tree]');

  return { step: stepIndex, action: 'click', target, outcome, delta: delta || undefined, message: line };
}

async function executeType(
  page: any,
  cdpClient: any,
  sessionId: string,
  tabId: string,
  parsedAction: ParsedAction,
  stepIndex: number,
  isStealth: boolean,
  context?: ToolContext
): Promise<StepResult> {
  const value = parsedAction.value;
  if (!value) {
    return { step: stepIndex, action: 'type', outcome: 'EXCEPTION', error: 'No value specified for type' };
  }

  // If a target is specified, find and focus it
  if (parsedAction.target) {
    const el = await resolveElement(page, cdpClient, parsedAction.target, context);
    if (!el) {
      return { step: stepIndex, action: 'type', target: parsedAction.target, outcome: 'ELEMENT_NOT_FOUND', error: `Could not find "${parsedAction.target}"` };
    }
    const x = Math.round(el.rect.x);
    const y = Math.round(el.rect.y);
    await page.mouse.click(x, y);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Clear existing content and type new value (Meta on macOS, Control elsewhere)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.press('KeyA');
  await page.keyboard.up(modifier);
  await page.keyboard.press('Backspace');

  if (isStealth) {
    await humanType(page, value);
  } else {
    await page.keyboard.type(value, { delay: 30 });
  }

  return {
    step: stepIndex,
    action: 'type',
    target: parsedAction.target,
    outcome: 'SUCCESS',
    message: `Typed "${value}"${parsedAction.target ? ` in "${parsedAction.target}"` : ''}`,
  };
}

async function executeSelect(
  page: any,
  cdpClient: any,
  sessionId: string,
  tabId: string,
  parsedAction: ParsedAction,
  stepIndex: number,
  context?: ToolContext
): Promise<StepResult> {
  const query = parsedAction.target || parsedAction.value;
  if (!query) {
    return { step: stepIndex, action: 'select', outcome: 'EXCEPTION', error: 'No target specified for select' };
  }

  const el = await resolveElement(page, cdpClient, query, context);
  if (!el) {
    return { step: stepIndex, action: 'select', target: query, outcome: 'ELEMENT_NOT_FOUND', error: `Could not find "${query}"` };
  }

  const value = parsedAction.value;
  if (value) {
    try {
      await page.evaluate(
        (nodeId: number, val: string) => {
          const el = document.querySelector(`[data-backend-node-id="${nodeId}"]`) as HTMLSelectElement | null;
          // Fallback: find by evaluating all selects
          const selects = Array.from(document.querySelectorAll('select'));
          const target = selects.find(s => {
            const rect = s.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (target) {
            target.value = val;
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        el.backendDOMNodeId,
        value
      );
    } catch (err) {
      return { step: stepIndex, action: 'select', target: query, outcome: 'EXCEPTION', error: `Select failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return {
    step: stepIndex,
    action: 'select',
    target: query,
    outcome: 'SUCCESS',
    message: `Selected "${value || query}"`,
  };
}

async function executeHover(
  page: any,
  cdpClient: any,
  parsedAction: ParsedAction,
  stepIndex: number,
  context?: ToolContext
): Promise<StepResult> {
  const target = parsedAction.target;
  if (!target) {
    return { step: stepIndex, action: 'hover', outcome: 'EXCEPTION', error: 'No target specified for hover' };
  }

  const el = await resolveElement(page, cdpClient, target, context);
  if (!el) {
    return { step: stepIndex, action: 'hover', target, outcome: 'ELEMENT_NOT_FOUND', error: `Could not find "${target}"` };
  }

  const x = Math.round(el.rect.x);
  const y = Math.round(el.rect.y);
  await page.mouse.move(x, y);

  return { step: stepIndex, action: 'hover', target, outcome: 'SUCCESS', message: `Hovered "${target}"` };
}

async function executeScroll(
  page: any,
  cdpClient: any,
  parsedAction: ParsedAction,
  stepIndex: number,
  context?: ToolContext
): Promise<StepResult> {
  if (parsedAction.target) {
    const el = await resolveElement(page, cdpClient, parsedAction.target, context);
    if (!el) {
      return { step: stepIndex, action: 'scroll', target: parsedAction.target, outcome: 'ELEMENT_NOT_FOUND', error: `Could not find "${parsedAction.target}"` };
    }
    try {
      await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendDOMNodeId });
    } catch {
      // Non-fatal
    }
  } else {
    // scroll up or down
    const direction = parsedAction.value === 'up' ? -500 : 500;
    await page.evaluate((dy: number) => window.scrollBy(0, dy), direction);
  }

  return { step: stepIndex, action: 'scroll', target: parsedAction.target, outcome: 'SUCCESS', message: `Scrolled ${parsedAction.value || parsedAction.target || 'down'}` };
}

async function executeWait(
  page: any,
  parsedAction: ParsedAction,
  stepIndex: number,
  context?: ToolContext
): Promise<StepResult> {
  if (parsedAction.target) {
    try {
      // Map condition to visible/hidden
      const hidden = parsedAction.condition === 'disappear';
      await withTimeout(
        page.waitForSelector(`::-p-text(${parsedAction.target})`, { hidden, timeout: 10000 })
          .catch(() => page.waitForFunction(
            (text: string) => document.body?.textContent?.includes(text),
            { timeout: 10000 },
            parsedAction.target
          )),
        10000,
        'wait',
        context
      );
    } catch {
      // Non-fatal — best effort
    }
  } else {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { step: stepIndex, action: 'wait', target: parsedAction.target, outcome: 'SUCCESS', message: `Waited for "${parsedAction.target || '1s'}"` };
}

async function executeNavigate(
  page: any,
  parsedAction: ParsedAction,
  stepIndex: number
): Promise<StepResult> {
  const url = parsedAction.value;
  if (!url) {
    return { step: stepIndex, action: 'navigate', outcome: 'EXCEPTION', error: 'No URL specified for navigate' };
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    return { step: stepIndex, action: 'navigate', target: url, outcome: 'EXCEPTION', error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { step: stepIndex, action: 'navigate', target: url, outcome: 'SUCCESS', message: `Navigated to "${url}"` };
}

async function executeCheckUncheck(
  page: any,
  cdpClient: any,
  sessionId: string,
  tabId: string,
  parsedAction: ParsedAction,
  stepIndex: number,
  isStealth: boolean,
  context?: ToolContext
): Promise<StepResult> {
  const target = parsedAction.target;
  if (!target) {
    return { step: stepIndex, action: parsedAction.action, outcome: 'EXCEPTION', error: `No target specified for ${parsedAction.action}` };
  }

  const el = await resolveElement(page, cdpClient, target, context);
  if (!el) {
    return { step: stepIndex, action: parsedAction.action, target, outcome: 'ELEMENT_NOT_FOUND', error: `Could not find "${target}"` };
  }

  const x = Math.round(el.rect.x);
  const y = Math.round(el.rect.y);

  // Check current state via properties
  const isChecked = el.properties?.checked === true || el.properties?.['aria-checked'] === 'true';
  const wantChecked = parsedAction.action === 'check';

  if (isChecked !== wantChecked) {
    const { delta } = await withDomDelta(page, async () => {
      if (isStealth) await humanMouseMove(page, x, y);
      await page.mouse.click(x, y);
    }, { settleMs: 200 });

    invalidateAXCache(getTargetId(page.target()));

    const outcome = classifyOutcome(delta, el.role);
    return { step: stepIndex, action: parsedAction.action, target, outcome, delta: delta || undefined };
  }

  // Already in desired state
  return { step: stepIndex, action: parsedAction.action, target, outcome: 'SUCCESS', message: `"${target}" already ${parsedAction.action}ed` };
}

// ─── Handler ───

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const instruction = args.instruction as string;
  const verify = args.verify !== false; // default true
  const timeoutMs = Math.min(Math.max((args.timeout as number) || 30000, 1000), 120000);

  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error: tabId is required' }], isError: true };
  }
  if (!instruction || instruction.trim().length === 0) {
    return { content: [{ type: 'text', text: 'Error: instruction is required' }], isError: true };
  }

  const sessionManager = getSessionManager();

  let page: any;
  try {
    page = await sessionManager.getPage(sessionId, tabId, undefined, 'act');
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  if (!page) {
    const available = await sessionManager.getAvailableTargets(sessionId).catch(() => []);
    const hint = available.length > 0
      ? `\nAvailable tabs:\n${available.map((t: any) => `  - tabId: ${t.tabId} | ${t.url}`).join('\n')}`
      : '\nNo tabs available.';
    return {
      content: [{ type: 'text', text: `Error: Tab ${tabId} not found.${hint}` }],
      isError: true,
    };
  }

  // 1. Try template match first (no page URL needed)
  const templateMatch = matchTemplate(instruction);
  let actions: ParsedAction[];
  let source: 'template' | 'cache' | 'parsed' = 'parsed';
  let parseWarning: string | undefined;

  if (templateMatch) {
    actions = templateMatch.actions;
    source = 'template';
  } else {
    // 2. Try cached sequence for this domain
    const pageUrl = page.url();
    const cached = getCachedSequence(pageUrl, instruction);
    if (cached) {
      actions = cached.actions;
      source = 'cache';
    } else {
      // 3. Fall back to NL parsing
      const parseResult = parseInstruction(instruction);
      if (!parseResult.success || parseResult.actions.length === 0) {
        const errMsg = parseResult.error || 'Could not parse instruction';
        const suggestion = parseResult.suggestion || 'Try individual steps like "click X", "type Y in Z".';
        return {
          content: [{
            type: 'text',
            text: `[act] Parse error: ${errMsg}\n\nSuggestion: ${suggestion}`,
          }],
          isError: true,
        };
      }
      actions = parseResult.actions;
      parseWarning = parseResult.suggestion;
    }
  }

  const cdpClient = sessionManager.getCDPClient();
  const isStealth = sessionManager.isStealthTarget(tabId);
  const stepResults: StepResult[] = [];
  let failedAt: number | null = null;

  const deadline = Date.now() + timeoutMs;

  for (let i = 0; i < actions.length; i++) {
    if (Date.now() >= deadline) {
      failedAt = i + 1;
      stepResults.push({ step: i + 1, action: actions[i].action, outcome: 'TIMEOUT', error: 'Sequence timeout exceeded' });
      break;
    }

    const parsedAction: ParsedAction = actions[i];
    let result: StepResult;

    try {
      switch (parsedAction.action) {
        case 'click':
          result = await executeClick(page, cdpClient, sessionId, tabId, parsedAction, i + 1, isStealth, context);
          break;
        case 'type':
          result = await executeType(page, cdpClient, sessionId, tabId, parsedAction, i + 1, isStealth, context);
          break;
        case 'select':
          result = await executeSelect(page, cdpClient, sessionId, tabId, parsedAction, i + 1, context);
          break;
        case 'hover':
          result = await executeHover(page, cdpClient, parsedAction, i + 1, context);
          break;
        case 'scroll':
          result = await executeScroll(page, cdpClient, parsedAction, i + 1, context);
          break;
        case 'wait':
          result = await executeWait(page, parsedAction, i + 1, context);
          break;
        case 'navigate':
          result = await executeNavigate(page, parsedAction, i + 1);
          break;
        case 'check':
        case 'uncheck':
          result = await executeCheckUncheck(page, cdpClient, sessionId, tabId, parsedAction, i + 1, isStealth, context);
          break;
        default:
          result = { step: i + 1, action: parsedAction.action, outcome: 'EXCEPTION', error: `Unknown action: ${parsedAction.action}` };
      }
    } catch (err) {
      result = {
        step: i + 1,
        action: parsedAction.action,
        target: parsedAction.target,
        outcome: 'EXCEPTION',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    stepResults.push(result);

    // Stop on hard failures
    if (result.outcome === 'ELEMENT_NOT_FOUND' || result.outcome === 'EXCEPTION' || result.outcome === 'TIMEOUT') {
      failedAt = i + 1;
      break;
    }
  }

  // Clean up any leftover discovery tags
  await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

  // Build response
  const total = actions.length;
  const executed = stepResults.length;
  const success = failedAt === null;

  // Cache successful parsed sequences for future use
  if (success && source === 'parsed') {
    try {
      cacheSequence(page.url(), instruction, actions);
      // Boost confidence above MIN_CONFIDENCE so the entry is retrievable immediately
      validateCachedSequence(page.url(), instruction, true);
    } catch { /* non-fatal */ }
  }

  // Boost confidence on successful cache hit
  if (success && source === 'cache') {
    try {
      validateCachedSequence(page.url(), instruction, true);
    } catch { /* non-fatal */ }
  }

  // If cached sequence failed, reduce confidence
  if (!success && source === 'cache') {
    try {
      validateCachedSequence(page.url(), instruction, false);
    } catch { /* non-fatal */ }
  }

  const sourceTag = source !== 'parsed' ? ` [${source}]` : '';
  const headerLine = success
    ? `[act] Executed ${executed}/${total} steps \u2713${sourceTag}`
    : `[act] Executed ${executed - 1}/${total} steps (failed at step ${failedAt})${sourceTag}`;

  const stepLines: string[] = [];
  for (const r of stepResults) {
    const isFailed = r.outcome === 'ELEMENT_NOT_FOUND' || r.outcome === 'EXCEPTION' || r.outcome === 'TIMEOUT';
    const symbol = isFailed ? '\u2717' : '\u2713';
    const label = r.message || r.error || `${r.action}${r.target ? ` "${r.target}"` : ''}`;
    stepLines.push(`Step ${r.step}: ${symbol} ${label}`);
  }

  const lines: string[] = [headerLine, '', ...stepLines];

  // Verification
  if (verify && success) {
    try {
      const state = await withTimeout(page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
      })), 3000, 'verify', context).catch(() => ({ url: '', title: '' })) as { url: string; title: string };
      lines.push('', `[Verification] url: ${state.url} | title: ${state.title}`);
    } catch { /* non-fatal */ }
  }

  // Surface parse warning if present
  if (parseWarning) {
    lines.push('', `[Warning] ${parseWarning}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: !success,
  };
};

// ─── Registration ───

export function registerActTool(server: MCPServer): void {
  server.registerTool('act', handler, definition);
}
