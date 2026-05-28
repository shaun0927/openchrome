/**
 * Act Tool - Execute multi-step browser actions from a natural language instruction.
 *
 * Parses the instruction into a structured action sequence (no LLM calls) and
 * executes each step sequentially, reporting per-step outcomes.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
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
import {
  cacheSequence,
  validateCachedSequence,
  ActionCacheKeyV2Parts,
  ActionCacheV2LookupDecision,
  buildActionCacheKeyV2Parts,
  cacheSequenceV2,
  getCachedSequenceV2,
  validateCachedSequenceV2,
  buildWorkflowPageSignature,
  cacheWorkflowSequence,
  getWorkflowCachedSequence,
  validateWorkflowCachedSequence,
  WorkflowCacheDecision,
  WorkflowPageSignature,
} from '../actions/action-cache';
import { coerceVerifyMode, runVerify, VERIFY_FIELD_SCHEMA, VerifyReport } from '../core/perception/verify';
import { appendReturnAfterState, parseReturnAfterState, RETURN_AFTER_STATE_SCHEMA } from './_shared/return-after-state';

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
      context: {
        type: 'string',
        description: 'Additional context (e.g., "on the login page")',
      },
      verify: VERIFY_FIELD_SCHEMA,
      timeout: {
        type: 'number',
        description: 'Max time in ms for entire sequence. Default: 30000',
      },
      use_workflow_cache: {
        type: 'boolean',
        description: 'Opt-in: try guarded structured workflow cache before legacy action cache. Default: false',
      },
      record_workflow_cache: {
        type: 'boolean',
        description: 'Opt-in: record safe successful parsed sequences into the structured workflow cache. Default: false',
      },
      allow_risky_replay: {
        type: 'boolean',
        description: 'Allow replay of workflow cache entries marked risky. Default: false',
      },
      workflow_debug: {
        type: 'boolean',
        description: 'Include concise workflow cache accept/reject metadata in the response. Default: false',
      },
      returnAfterState: RETURN_AFTER_STATE_SCHEMA,
    },
    required: ['tabId', 'instruction'],
  },
  annotations: TOOL_ANNOTATIONS.act,
};


interface SamplingDecision {
  used: boolean;
  supported: boolean;
  fallbackReason?: string;
}

const VALID_ACTIONS = new Set(['click', 'type', 'select', 'hover', 'scroll', 'wait', 'navigate', 'check', 'uncheck']);

function parseSampledActions(value: unknown): ParsedAction[] | null {
  const text = typeof value === 'string'
    ? value
    : typeof (value as { content?: Array<{ type?: string; text?: string }> })?.content?.[0]?.text === 'string'
      ? (value as { content: Array<{ text: string }> }).content[0].text
      : undefined;
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const actions = (parsed as { actions?: unknown }).actions;
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const normalized: ParsedAction[] = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') return null;
    const record = action as Record<string, unknown>;
    if (typeof record.action !== 'string' || !VALID_ACTIONS.has(record.action)) return null;
    // `url` is accepted as a synonym for `value` (e.g. navigate actions) but
    // must not silently shadow an explicit `value` the sampler also emitted.
    const valueField = typeof record.value === 'string'
      ? record.value
      : typeof record.url === 'string'
        ? record.url
        : undefined;
    normalized.push({
      action: record.action as ParsedAction['action'],
      ...(typeof record.target === 'string' ? { target: record.target } : {}),
      ...(valueField !== undefined ? { value: valueField } : {}),
      ...(typeof record.condition === 'string' ? { condition: record.condition } : {}),
    });
  }
  return normalized;
}

async function maybeRefineActionsWithSampling(
  instruction: string,
  actions: ParsedAction[],
  context?: ToolContext,
): Promise<{ actions: ParsedAction[]; decision: SamplingDecision }> {
  if (!context?.clientCapabilities?.sampling || !context.requestClient) {
    return { actions, decision: { used: false, supported: false, fallbackReason: 'sampling_unavailable' } };
  }
  if (actions.length < 2) {
    return { actions, decision: { used: false, supported: true, fallbackReason: 'single_action' } };
  }
  try {
    const response = await context.requestClient<unknown>('sampling/createMessage', {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Choose the safest deterministic OpenChrome act action sequence for: ${instruction}\nReturn strict JSON only: {"actions":[{"action":"click|type|select|hover|scroll|wait|navigate|check|uncheck","target":"optional","value":"optional","condition":"optional"}]}`,
        },
      }],
      maxTokens: 400,
    }, { timeoutMs: 8000, signal: context.signal });
    const sampled = parseSampledActions(response);
    if (!sampled) return { actions, decision: { used: false, supported: true, fallbackReason: 'invalid_sampling_response' } };
    return { actions: sampled, decision: { used: true, supported: true } };
  } catch (err) {
    // Map known transport/cancel signatures to closed-set reasons so we don't
    // leak raw transport text to clients in `_meta.sampling.fallbackReason`.
    const message = err instanceof Error ? err.message : String(err);
    const fallbackReason = /timeout/i.test(message)
      ? 'timeout'
      : /abort|cancel/i.test(message)
        ? 'cancelled'
        : 'transport_error';
    return { actions, decision: { used: false, supported: true, fallbackReason } };
  }
}

// ─── Element resolution helper ───

async function collectWorkflowPageSignature(page: any): Promise<WorkflowPageSignature | null> {
  try {
    const projection = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll(
        'button, a, input, select, textarea, [role], [aria-label], [placeholder]'
      )).slice(0, 250);

      const actionLabels: string[] = [];
      const actionRoles: string[] = [];
      const formShape: string[] = [];

      for (const el of controls) {
        const element = el as HTMLElement;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const tag = element.tagName.toLowerCase();
        const input = element as HTMLInputElement;
        const type = (input.getAttribute?.('type') || '').toLowerCase();
        const role = element.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag);
        const label = element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.getAttribute('placeholder')
          || (type === 'password' ? '' : (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
          || (type === 'password' ? '' : (input.name || input.id || ''));

        if (label) actionLabels.push(label.slice(0, 120));
        if (role) actionRoles.push(role);
        if (tag === 'input' || tag === 'select' || tag === 'textarea') {
          formShape.push(`${tag}:${type || role}:${label ? 'label' : 'unlabelled'}`);
        }
      }

      return { title: document.title, actionLabels, actionRoles, formShape };
    });

    return buildWorkflowPageSignature(projection);
  } catch {
    return null;
  }
}


async function collectActionCacheKeyParts(
  page: any,
  pageUrl: string,
  instruction: string,
  actions: ParsedAction[],
  optionFingerprint: string,
): Promise<ActionCacheKeyV2Parts | null> {
  try {
    const projection = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll(
        'button, a, input, select, textarea, [role], [aria-label], [placeholder]'
      )).slice(0, 120).map((el) => {
        const element = el as HTMLElement;
        const input = element as HTMLInputElement;
        const rect = element.getBoundingClientRect();
        const tag = element.tagName.toLowerCase();
        const type = (input.getAttribute?.('type') || '').toLowerCase();
        const role = element.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag);
        const rawName = element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.getAttribute('placeholder')
          || (type === 'password' ? '' : (element.innerText || element.textContent || ''))
          || (type === 'password' ? '' : (input.name || input.id || ''));
        return {
          role,
          name: String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          tag,
          type,
          disabled: Boolean((input as { disabled?: boolean }).disabled),
          visible: rect.width > 0 && rect.height > 0,
        };
      }).filter(node => node.visible);

      return {
        title: document.title,
        path: window.location.pathname,
        locale: navigator.language,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        nodes,
      };
    });

    return buildActionCacheKeyV2Parts({
      url: pageUrl,
      instruction,
      actionKinds: actions.map(action => action.action),
      viewport: projection.viewport,
      locale: projection.locale,
      userAgent: projection.userAgent,
      pageFingerprint: JSON.stringify({ title: projection.title, path: projection.path, nodes: projection.nodes }),
      optionFingerprint,
    });
  } catch {
    return null;
  }
}

function formatActionCacheStatus(decision: ActionCacheV2LookupDecision | null): string {
  if (!decision) return '[cache] status=BYPASS keyVersion=2 reason=unavailable';
  const parts = [`status=${decision.status}`, `keyVersion=${decision.keyVersion}`, `reason=${decision.reason}`];
  if (decision.keyHash) parts.push(`key=${decision.keyHash.slice(0, 12)}`);
  return `[cache] ${parts.join(' ')}`;
}

function formatWorkflowDebug(decision: WorkflowCacheDecision): string {
  const parts = [`decision=${decision.decision}`, `reason=${decision.reason}`];
  if (typeof decision.similarity === 'number') parts.push(`similarity=${decision.similarity}`);
  if (decision.cacheAction) parts.push(`cacheAction=${decision.cacheAction}`);
  if (decision.safety?.destructiveRisk && decision.safety.destructiveRisk !== 'none') {
    parts.push(`destructiveRisk=${decision.safety.destructiveRisk}`);
  }
  return `[WorkflowCache] ${parts.join(' ')}`;
}

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

const coreHandler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const instruction = args.instruction as string;
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
  const timeoutMs = Math.min(Math.max((args.timeout as number) || 30000, 1000), 120000);
  const useWorkflowCache = args.use_workflow_cache === true;
  const recordWorkflowCache = args.record_workflow_cache === true;
  const allowRiskyReplay = args.allow_risky_replay === true;
  const workflowDebug = args.workflow_debug === true;

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
  let source: 'template' | 'cache' | 'workflow_cache' | 'parsed' = 'parsed';
  let parseWarning: string | undefined;
  let workflowSignature: WorkflowPageSignature | null = null;
  let workflowDecision: WorkflowCacheDecision | null = null;
  let actionCacheKeyParts: ActionCacheKeyV2Parts | null = null;
  let actionCacheUrl: string | null = null;
  let actionCacheDecision: ActionCacheV2LookupDecision | null = null;

  if (templateMatch) {
    actions = templateMatch.actions;
    source = 'template';
  } else {
    const pageUrl = page.url();

    // 2. Try guarded structured workflow cache only when explicitly requested.
    if (useWorkflowCache) {
      workflowSignature = await collectWorkflowPageSignature(page);
      workflowDecision = workflowSignature
        ? getWorkflowCachedSequence(pageUrl, instruction, workflowSignature, { allowRiskyReplay })
        : { decision: 'miss', reason: 'signature_unavailable' };
    }

    if (workflowDecision?.decision === 'accepted' && workflowDecision.actions) {
      actions = workflowDecision.actions;
      source = 'workflow_cache';
      actionCacheDecision = { status: 'BYPASS', keyVersion: 2, reason: 'workflow_cache_accepted' };
    } else {
      // 3. Parse deterministically, then use parsed action kinds to build the
      // safer page-fingerprint action cache v2 key.
      const parseResult = parseInstruction(instruction);
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
      actionCacheKeyParts = await collectActionCacheKeyParts(page, pageUrl, instruction, actions, `verify=${verifyMode}`);
      actionCacheUrl = actionCacheKeyParts ? pageUrl : null;
      actionCacheDecision = actionCacheKeyParts
        ? getCachedSequenceV2(pageUrl, instruction, actionCacheKeyParts, { allowLegacyFallback: true })
        : { status: 'BYPASS', keyVersion: 2, reason: 'fingerprint_unavailable' };

      if (actionCacheDecision.actions && actionCacheDecision.status === 'HIT') {
        actions = actionCacheDecision.actions;
        source = 'cache';
      }
    }
  }

  // Cached/templated sequences are already known-good; subjecting them to a
  // sampling round-trip would only add tokens and risk regressions per P4/P7.
  const allowSampling = source === 'parsed';
  const samplingResult = allowSampling
    ? await maybeRefineActionsWithSampling(instruction, actions, context)
    : { actions, decision: { used: false, supported: false, fallbackReason: `skipped_${source}` } as SamplingDecision };
  actions = samplingResult.actions;
  const samplingDecision = samplingResult.decision;

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
  return undefined as void;
  });
  const actVerifyReport: VerifyReport | undefined = verifyOutcome.verify;

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
      if (actionCacheKeyParts && actionCacheUrl) cacheSequenceV2(actionCacheUrl, instruction, actions, actionCacheKeyParts);
      // Boost confidence above MIN_CONFIDENCE so the entry is retrievable immediately
      validateCachedSequence(page.url(), instruction, true);
    } catch { /* non-fatal */ }

    if (recordWorkflowCache) {
      try {
        workflowSignature = workflowSignature || await collectWorkflowPageSignature(page);
        if (workflowSignature) {
          const entry = cacheWorkflowSequence(page.url(), instruction, actions, workflowSignature);
          workflowDecision = entry
            ? { decision: 'accepted', reason: 'recorded', entry, safety: entry.safety }
            : { decision: 'miss', reason: 'record_failed' };
        }
      } catch { /* non-fatal */ }
    }
  }

  // Boost confidence on successful cache hit
  if (success && source === 'cache') {
    try {
      if (actionCacheDecision?.keyVersion === 2 && actionCacheDecision.keyHash) {
        validateCachedSequenceV2(page.url(), instruction, actionCacheDecision.keyHash, true);
      } else {
        validateCachedSequence(page.url(), instruction, true);
      }
    } catch { /* non-fatal */ }
  }

  if (success && source === 'workflow_cache') {
    try {
      workflowDecision = validateWorkflowCachedSequence(page.url(), instruction, true);
    } catch { /* non-fatal */ }
  }

  // If cached sequence failed, reduce confidence
  if (!success && source === 'cache') {
    try {
      if (actionCacheDecision?.keyVersion === 2 && actionCacheDecision.keyHash) {
        validateCachedSequenceV2(page.url(), instruction, actionCacheDecision.keyHash, false);
      } else {
        validateCachedSequence(page.url(), instruction, false);
      }
    } catch { /* non-fatal */ }
  }

  if (!success && source === 'workflow_cache') {
    try {
      const failed = failedAt !== null ? stepResults[failedAt - 1] : stepResults[stepResults.length - 1];
      workflowDecision = validateWorkflowCachedSequence(page.url(), instruction, false, failed?.outcome || 'replay_failed');
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

  const lines: string[] = [headerLine, formatActionCacheStatus(actionCacheDecision), '', ...stepLines];

  // Verification — legacy text summary. Preserved verbatim so default
  // (`verify` absent or `true`) callers see the same `[Verification] …` line.
  if (verifyTextSummary && success) {
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

  // Only surface the [Sampling] line and `_meta.sampling` when the connected
  // client actually advertised sampling; otherwise this would pollute every
  // act result for clients that never opted into sampling.
  if (samplingDecision.supported) {
    const reason = samplingDecision.fallbackReason ? ` fallback=${samplingDecision.fallbackReason}` : '';
    lines.push('', `[Sampling] used=${samplingDecision.used}${reason}`);
  }

  if (workflowDebug && workflowDecision) {
    lines.push('', formatWorkflowDebug(workflowDecision));
  }

  const baseResult: MCPResult = {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: !success,
  };
  const withMeta = samplingDecision.supported ? { ...baseResult, _meta: { sampling: samplingDecision } } : baseResult;
  return actVerifyReport ? { ...withMeta, verify: actVerifyReport } : withMeta;
};

// ─── Registration ───


const handler: ToolHandler = async (sessionId, args, context): Promise<MCPResult> => {
  const result = await coreHandler(sessionId, args, context);
  const returnAfterState = parseReturnAfterState(args.returnAfterState);
  if (returnAfterState === 'none' || result.isError) return result;

  const tabId = args.tabId as string | undefined;
  if (!tabId) return result;

  try {
    const page = await getSessionManager().getPage(sessionId, tabId, undefined, 'act');
    if (page) {
      await appendReturnAfterState(result, page, sessionId, tabId, returnAfterState, context);
    }
  } catch {
    // Snapshot chaining is best-effort; never mask the successful action result.
  }
  return result;
};

export function registerActTool(server: MCPServer): void {
  server.registerTool('act', handler, definition);
}
export const __test__ = { maybeRefineActionsWithSampling, parseSampledActions };
