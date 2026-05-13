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
import { coerceVerifyMode, runVerify, VERIFY_FIELD_SCHEMA, VerifyReport } from '../core/perception/verify';
import {
  appendReturnAfterState,
  parseReturnAfterState,
  RETURN_AFTER_STATE_SCHEMA,
} from './_shared/return-after-state';


const VARIABLE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/g;

function normalizeVariables(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  return out;
}

function findMissingVariables(instruction: string, variables: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const match of instruction.matchAll(VARIABLE_RE)) names.add(match[1]);
  return Array.from(names).filter((name) => !(name in variables));
}

function substituteVariableText(text: string | undefined, variables: Record<string, string>): string | undefined {
  if (text === undefined) return undefined;
  return text.replace(VARIABLE_RE, (_m, name: string) => variables[name] ?? _m);
}

function substituteActionVariables(action: ParsedAction, variables: Record<string, string>): ParsedAction {
  return {
    ...action,
    target: substituteVariableText(action.target, variables),
    value: substituteVariableText(action.value, variables),
    condition: substituteVariableText(action.condition, variables),
  };
}

function redactVariableValues(text: string, variables: Record<string, string>): string {
  const matches: Array<{ start: number; end: number; label: string }> = [];
  for (const [name, value] of Object.entries(variables)) {
    if (value.length === 0) continue;
    let start = text.indexOf(value);
    while (start !== -1) {
      matches.push({ start, end: start + value.length, label: `%${name}%` });
      start = text.indexOf(value, start + 1);
    }
  }
  if (matches.length === 0) return text;

  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const chunks: Array<{ start: number; end: number; label: string; ambiguous: boolean }> = [];
  for (const match of matches) {
    const last = chunks[chunks.length - 1];
    if (!last || match.start >= last.end) {
      chunks.push({ ...match, ambiguous: false });
      continue;
    }
    if (match.end <= last.end) continue;
    last.end = match.end;
    last.ambiguous = true;
  }

  let redacted = '';
  let offset = 0;
  for (const chunk of chunks) {
    redacted += text.slice(offset, chunk.start);
    redacted += chunk.ambiguous ? '[REDACTED_VARIABLE]' : chunk.label;
    offset = chunk.end;
  }
  redacted += text.slice(offset);
  return redacted;
}

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

type ActSource = 'template' | 'cache' | 'parsed' | 'structured';

type RecoveryReason =
  | 'target_not_found'
  | 'ambiguous_target'
  | 'stale_ref_or_selector'
  | 'navigation_timeout'
  | 'page_not_ready'
  | 'actionability_failed'
  | 'sequence_timeout'
  | 'exception';

interface SuggestedNextCall {
  tool: 'read_page' | 'query_dom' | 'wait_for';
  arguments: Record<string, unknown>;
  why: string;
}

interface NearMatch {
  ref?: string;
  label?: string;
  text?: string;
  role?: string;
  tag?: string;
  score: number;
}

interface ActRecovery {
  reason: RecoveryReason;
  safeToRetry: boolean;
  suggestedNextCalls: SuggestedNextCall[];
  nearMatches: NearMatch[];
  cacheAction?: 'decrement_confidence';
}

// ─── Tool Definition ───

const definition: MCPToolDefinition = {
  name: 'act',
  description: 'Execute multi-step browser actions from a natural language instruction. Parses and runs click, type, select, scroll, hover, navigate, and wait steps in sequence.\n\nWhen to use: Automating a known multi-step flow (login, form fill, navigation) in one call.\nWhen NOT to use: Use interact for a single element action, or computer for raw coordinate input.',
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
      steps: {
        type: 'array',
        description: 'Structured same-tab action sequence. Use this to skip natural-language parsing for low-latency macros.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'select', 'check', 'uncheck', 'hover', 'scroll', 'wait', 'navigate'] },
            target: { type: 'string' },
            value: { type: 'string' },
            condition: { type: 'string' },
          },
          required: ['action'],
        },
      },
      context: {
        type: 'string',
        description: 'Additional context (e.g., "on the login page")',
      },
      verify: VERIFY_FIELD_SCHEMA,
      timeout: {
        type: 'number',
        description: 'Max time in ms for entire sequence. Default: 30000',
      },
      variables: {
        type: 'object',
        description: 'Optional runtime values for %name% placeholders. Values are injected only at execution time and redacted from responses/cache.',
      },
      returnAfterState: RETURN_AFTER_STATE_SCHEMA,
    },
    required: ['tabId'],
  },
};

// ─── Element resolution helper ───

function classifyFailureReason(step: StepResult): RecoveryReason {
  if (step.outcome === 'TIMEOUT') return 'sequence_timeout';
  if (step.outcome === 'ELEMENT_NOT_FOUND') return 'target_not_found';

  const message = (step.error || step.message || '').toLowerCase();
  if (message.includes('timeout') && step.action === 'navigate') return 'navigation_timeout';
  if (message.includes('timeout')) return 'page_not_ready';
  if (message.includes('stale') || message.includes('selector')) return 'stale_ref_or_selector';
  if (message.includes('not visible') || message.includes('not clickable') || message.includes('disabled')) return 'actionability_failed';
  if (message.includes('ambiguous') || message.includes('multiple')) return 'ambiguous_target';
  return 'exception';
}

function buildSuggestedNextCalls(tabId: string, reason: RecoveryReason, target?: string): SuggestedNextCall[] {
  const calls: SuggestedNextCall[] = [];

  if (reason === 'page_not_ready' || reason === 'navigation_timeout' || reason === 'sequence_timeout') {
    calls.push({
      tool: 'wait_for',
      arguments: { tabId, type: 'function', value: 'document.readyState !== "loading"', timeout: 10000 },
      why: 'Wait for the page to settle before retrying the deterministic action sequence.',
    });
  }

  calls.push({
    tool: 'read_page',
    arguments: { tabId, mode: 'dom', filter: 'interactive', depth: 5 },
    why: 'Refresh the compact interactive DOM before retrying target resolution.',
  });

  calls.push({
    tool: 'query_dom',
    arguments: {
      tabId,
      method: 'css',
      selector: target && target.trim().length > 0
        ? 'button, a, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [aria-label], [placeholder]'
        : 'button, a, input, select, textarea, [role]',
      multiple: true,
      limit: 50,
    },
    why: 'Inspect common interactive controls with labels/placeholders for a narrower retry.',
  });

  return calls.slice(0, 3);
}

function scoreNearMatch(target: string, candidate: string, role?: string): number {
  const t = normalizeQuery(target || '');
  const c = normalizeQuery(candidate || '');
  if (!t || !c) return 0;
  if (t === c) return 1;

  let score = 0;
  if (c.includes(t) || t.includes(c)) score = Math.max(score, 0.72);
  const tTokens = new Set(t.split(/\s+/).filter(Boolean));
  const cTokens = new Set(c.split(/\s+/).filter(Boolean));
  const overlap = [...tTokens].filter(tok => cTokens.has(tok)).length;
  if (tTokens.size > 0) score = Math.max(score, (overlap / tTokens.size) * 0.65);
  if (role && /button|link|textbox|checkbox|radio|combobox/.test(role.toLowerCase())) score += 0.08;
  return Math.min(1, Math.round(score * 100) / 100);
}

async function collectNearMatches(page: any, target?: string): Promise<NearMatch[]> {
  if (!target || !target.trim()) return [];
  try {
    const candidates = await page.evaluate((wanted: string) => {
      void wanted;
      const controls = Array.from(document.querySelectorAll(
        'button, a, input, select, textarea, [role], [aria-label], [placeholder]'
      )).slice(0, 250);
      return controls.map((el) => {
        const element = el as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const input = element as HTMLInputElement;
        const type = (input.getAttribute?.('type') || '').toLowerCase();
        const role = element.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag);
        const label = element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.getAttribute('placeholder')
          || '';
        const rawText = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        const text = type === 'password' ? '' : rawText.slice(0, 120);
        const name = type === 'password' ? '' : (input.name || input.id || '');
        const candidate = [label, text, name, role, tag].filter(Boolean).join(' ');
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        return { label: label || undefined, text: text || undefined, role, tag, candidate, visible };
      }).filter((item) => item.visible && item.candidate.length > 0);
    }, target) as Array<{ label?: string; text?: string; role?: string; tag?: string; candidate: string; visible: boolean }> | undefined;

    if (!Array.isArray(candidates)) return [];
    return candidates
      .map((candidate) => ({
        label: candidate.label,
        text: candidate.text,
        role: candidate.role,
        tag: candidate.tag,
        score: scoreNearMatch(target, candidate.candidate, candidate.role),
      }))
      .filter((candidate) => candidate.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function buildRecovery(page: any, tabId: string, failedStep: StepResult, source: ActSource): Promise<ActRecovery> {
  const reason = classifyFailureReason(failedStep);
  const nearMatches = reason === 'target_not_found' || reason === 'ambiguous_target'
    ? await collectNearMatches(page, failedStep.target)
    : [];

  return {
    reason,
    safeToRetry: reason !== 'exception' && reason !== 'actionability_failed',
    suggestedNextCalls: buildSuggestedNextCalls(tabId, reason, failedStep.target),
    nearMatches,
    ...(source === 'cache' ? { cacheAction: 'decrement_confidence' as const } : {}),
  };
}

function buildFailurePayload(params: {
  source: ActSource;
  executed: number;
  total: number;
  failedAt: number | null;
  failedStep: StepResult | undefined;
  recovery: ActRecovery;
  text: string;
}): string {
  return JSON.stringify({
    action: 'act',
    success: false,
    source: params.source,
    executed: Math.max(0, params.failedAt ? params.failedAt - 1 : params.executed),
    total: params.total,
    failedAt: params.failedAt,
    failedStep: params.failedStep,
    recovery: params.recovery,
    text: params.text,
  }, null, 2);
}

/**
 * Resolve element coordinates via AX tree. Returns null if resolution fails.
 */
async function resolveElement(
  page: Parameters<typeof resolveElementsByAXTree>[0],
  cdpClient: Parameters<typeof resolveElementsByAXTree>[1],
  query: string,
  context?: ToolContext,
  contextHint?: string
): Promise<AXResolvedElement | null> {
  try {
    const matches = await withTimeout(
      resolveElementsByAXTree(page, cdpClient, normalizeQuery(query), { useCenter: true, maxResults: 3, contextHint }),
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
  context?: ToolContext,
  contextHint?: string
): Promise<StepResult> {
  const target = parsedAction.target;
  if (!target) {
    return { step: stepIndex, action: 'click', outcome: 'ELEMENT_NOT_FOUND', error: 'No target specified for click' };
  }

  const el = await resolveElement(page, cdpClient, target, context, contextHint);
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
  context?: ToolContext,
  contextHint?: string
): Promise<StepResult> {
  const value = parsedAction.value;
  if (!value) {
    return { step: stepIndex, action: 'type', outcome: 'EXCEPTION', error: 'No value specified for type' };
  }

  // If a target is specified, find and focus it
  if (parsedAction.target) {
    const el = await resolveElement(page, cdpClient, parsedAction.target, context, contextHint);
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
  context?: ToolContext,
  contextHint?: string
): Promise<StepResult> {
  const query = parsedAction.target || parsedAction.value;
  if (!query) {
    return { step: stepIndex, action: 'select', outcome: 'EXCEPTION', error: 'No target specified for select' };
  }

  const el = await resolveElement(page, cdpClient, query, context, contextHint);
  if (!el) {
    return { step: stepIndex, action: 'select', target: query, outcome: 'ELEMENT_NOT_FOUND', error: `Could not find "${query}"` };
  }

  const value = parsedAction.value;
  if (value) {
    try {
      await page.evaluate(
        (nodeId: number, val: string) => {
          void nodeId;
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
  context?: ToolContext,
  contextHint?: string
): Promise<StepResult> {
  const target = parsedAction.target;
  if (!target) {
    return { step: stepIndex, action: 'hover', outcome: 'EXCEPTION', error: 'No target specified for hover' };
  }

  const el = await resolveElement(page, cdpClient, target, context, contextHint);
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
  context?: ToolContext,
  contextHint?: string
): Promise<StepResult> {
  if (parsedAction.target) {
    const el = await resolveElement(page, cdpClient, parsedAction.target, context, contextHint);
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
  context?: ToolContext,
  contextHint?: string
): Promise<StepResult> {
  const target = parsedAction.target;
  if (!target) {
    return { step: stepIndex, action: parsedAction.action, outcome: 'EXCEPTION', error: `No target specified for ${parsedAction.action}` };
  }

  const el = await resolveElement(page, cdpClient, target, context, contextHint);
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


function normalizeStructuredSteps(value: unknown): { actions?: ParsedAction[]; error?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'steps must be a non-empty array when provided' };
  }
  if (value.length > 20) {
    return { error: 'steps is limited to 20 actions per act call' };
  }

  const allowed = new Set(['click', 'type', 'select', 'check', 'uncheck', 'hover', 'scroll', 'wait', 'navigate']);
  const actions: ParsedAction[] = [];

  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (!raw || typeof raw !== 'object') {
      return { error: `steps[${i}] must be an object` };
    }
    const step = raw as Record<string, unknown>;
    const action = step.action;
    if (typeof action !== 'string' || !allowed.has(action)) {
      return { error: `steps[${i}].action must be one of: ${Array.from(allowed).join(', ')}` };
    }
    const parsed: ParsedAction = { action: action as ParsedAction['action'] };
    if (typeof step.target === 'string') parsed.target = step.target;
    if (typeof step.value === 'string') parsed.value = step.value;
    if (typeof step.condition === 'string') parsed.condition = step.condition;
    actions.push(parsed);
  }

  return { actions };
}

// ─── Handler ───

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const instruction = args.instruction as string | undefined;
  // Legacy text-summary verification fires when:
  //   * args.verify is undefined  → pre-#827 default of "always summarize"
  //   * args.verify is any value coercing to a non-'none' mode (true, the
  //     legacy default; "ax-diff"; "screenshot"; "both")
  // It is suppressed when args.verify is explicitly false or "none". Without
  // the explicit undefined branch, `args.verify !== false` would also have
  // accepted the string "none" (codex P2 bug); going through coerceVerifyMode
  // closes that hole while preserving backwards compat for callers that
  // omit the field entirely.
  const verifyMode = coerceVerifyMode(args.verify);
  const verifyTextSummary =
    args.verify === undefined ? true : verifyMode !== 'none';
  const actionContext = typeof args.context === 'string' ? args.context.slice(0, 240) : undefined;
  const timeoutMs = Math.min(Math.max((args.timeout as number) || 30000, 1000), 120000);
  const variables = normalizeVariables(args.variables);
  const missingVariables = findMissingVariables(instruction || '', variables);
  const returnAfterState = parseReturnAfterState(args.returnAfterState);

  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error: tabId is required' }], isError: true };
  }
  const structured = normalizeStructuredSteps(args.steps);
  if (structured.error) {
    return { content: [{ type: 'text', text: `Error: ${structured.error}` }], isError: true };
  }
  if (!structured.actions && (!instruction || instruction.trim().length === 0)) {
    return { content: [{ type: 'text', text: 'Error: instruction or steps is required' }], isError: true };
  }
  if (missingVariables.length > 0) {
    return {
      content: [{ type: 'text', text: `Error: Missing variable(s): ${missingVariables.map((name) => `%${name}%`).join(', ')}` }],
      isError: true,
    };
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

  // 1. Prefer structured steps when supplied; this skips parsing/cache lookup for low-latency macros.
  let actions: ParsedAction[];
  let source: ActSource = 'parsed';
  let parseWarning: string | undefined;

  if (structured.actions) {
    actions = structured.actions;
    source = 'structured';
  } else {
    const safeInstruction = instruction!.trim();
    // 2. Try template match first (no page URL needed)
    const templateMatch = matchTemplate(safeInstruction);

    if (templateMatch) {
      actions = templateMatch.actions;
      source = 'template';
    } else {
      // 3. Try cached sequence for this domain
      const pageUrl = page.url();
      const cached = getCachedSequence(pageUrl, safeInstruction);
      if (cached) {
        actions = cached.actions;
        source = 'cache';
      } else {
        // 4. Fall back to NL parsing
        const parseResult = parseInstruction(safeInstruction);
        if (!parseResult.success || parseResult.actions.length === 0) {
          const errMsg = parseResult.error || 'Could not parse instruction';
          const suggestion = parseResult.suggestion || 'Try individual steps like "click X", "type Y in Z".';
          return {
            content: [{
              type: 'text',
              text: `[act] Parse error: ${errMsg}

Suggestion: ${suggestion}`,
            }],
            isError: true,
          };
        }
        actions = parseResult.actions;
        parseWarning = parseResult.suggestion;
      }
    }
  }

  const executionActions = actions.map((action) => substituteActionVariables(action, variables));

  const cdpClient = sessionManager.getCDPClient();
  const isStealth = sessionManager.isStealthTarget(tabId);
  const stepResults: StepResult[] = [];
  let failedAt: number | null = null;

  const deadline = Date.now() + timeoutMs;

  // Wrap the entire action sequence in runVerify so AX-hash + pHash deltas
  // bracket the whole composite operation (issue #827). When mode is 'none'
  // this returns `verify: undefined` and the result is byte-identical to
  // pre-#827 develop.
  const verifyOutcome = await runVerify(page, verifyMode, async () => {
  for (let i = 0; i < executionActions.length; i++) {
    if (Date.now() >= deadline) {
      failedAt = i + 1;
      stepResults.push({ step: i + 1, action: executionActions[i].action, outcome: 'TIMEOUT', error: 'Sequence timeout exceeded' });
      break;
    }

    const parsedAction: ParsedAction = executionActions[i];
    let result: StepResult;

    try {
      switch (parsedAction.action) {
        case 'click':
          result = await executeClick(page, cdpClient, sessionId, tabId, parsedAction, i + 1, isStealth, context, actionContext);
          break;
        case 'type':
          result = await executeType(page, cdpClient, sessionId, tabId, parsedAction, i + 1, isStealth, context, actionContext);
          break;
        case 'select':
          result = await executeSelect(page, cdpClient, sessionId, tabId, parsedAction, i + 1, context, actionContext);
          break;
        case 'hover':
          result = await executeHover(page, cdpClient, parsedAction, i + 1, context, actionContext);
          break;
        case 'scroll':
          result = await executeScroll(page, cdpClient, parsedAction, i + 1, context, actionContext);
          break;
        case 'wait':
          result = await executeWait(page, parsedAction, i + 1, context);
          break;
        case 'navigate':
          result = await executeNavigate(page, parsedAction, i + 1);
          break;
        case 'check':
        case 'uncheck':
          result = await executeCheckUncheck(page, cdpClient, sessionId, tabId, parsedAction, i + 1, isStealth, context, actionContext);
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
  return undefined as void;
  });
  const actVerifyReport: VerifyReport | undefined = verifyOutcome.verify;

  // Clean up any leftover discovery tags
  await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

  // Build response
  const total = executionActions.length;
  const executed = stepResults.length;
  const success = failedAt === null;

  // Cache successful parsed sequences for future use
  if (success && source === 'parsed' && instruction) {
    try {
      cacheSequence(page.url(), instruction.trim(), actions);
      // Boost confidence above MIN_CONFIDENCE so the entry is retrievable immediately
      validateCachedSequence(page.url(), instruction.trim(), true);
    } catch { /* non-fatal */ }
  }

  // Boost confidence on successful cache hit
  if (success && source === 'cache') {
    try {
      validateCachedSequence(page.url(), instruction!.trim(), true);
    } catch { /* non-fatal */ }
  }

  // If cached sequence failed, reduce confidence
  if (!success && source === 'cache') {
    try {
      validateCachedSequence(page.url(), instruction!.trim(), false);
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
    stepLines.push(`Step ${r.step}: ${symbol} ${redactVariableValues(label, variables)}`);
  }

  const lines: string[] = [headerLine, '', ...stepLines];

  // Verification — legacy text summary. Preserved verbatim so default
  // (`verify` absent or `true`) callers see the same `[Verification] …` line.
  if (verifyTextSummary && success) {
    try {
      const state = await withTimeout(page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
      })), 3000, 'verify', context).catch(() => ({ url: '', title: '' })) as { url: string; title: string };
      lines.push('', redactVariableValues(`[Verification] url: ${state.url} | title: ${state.title}`, variables));
    } catch { /* non-fatal */ }
  }

  // Surface parse warning if present
  if (parseWarning) {
    lines.push('', `[Warning] ${parseWarning}`);
  }

  const text = lines.join('\n');
  let responseText = text;
  if (!success) {
    const failedStep = failedAt !== null ? stepResults[failedAt - 1] : stepResults[stepResults.length - 1];
    const recovery = await buildRecovery(page, tabId, failedStep, source);
    responseText = buildFailurePayload({
      source,
      executed,
      total,
      failedAt,
      failedStep,
      recovery,
      text,
    });
  }

  const actResult: MCPResult = {
    content: [{ type: 'text', text: responseText }],
    isError: !success,
    ...(actVerifyReport ? { verify: actVerifyReport } : {}),
  };
  if (success) {
    await appendReturnAfterState(actResult, page, sessionId, tabId, returnAfterState, context);
  }
  return actResult;
};

// ─── Registration ───

export function registerActTool(server: MCPServer): void {
  server.registerTool('act', handler, definition);
}
