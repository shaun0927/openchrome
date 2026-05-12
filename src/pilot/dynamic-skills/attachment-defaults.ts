/**
 * Production attachment defaults for the dynamic-skills replay handler.
 *
 * The bootstrap (`./index.ts`) accepts a {@link DynamicSkillsAttachment}
 * blob — in tests, deterministic fakes are injected. In production
 * (`src/index.ts:attachDynamicSkillsToServer`), we wire the real
 * session-manager + Puppeteer surface here so the feature actually
 * runs when the opt-in env var is set.
 *
 * Per portability-harness P3 (no outbound LLM call): every action
 * driven from this module goes through the local CDP session. No
 * third-party HTTP, no LLM API.
 *
 * Tab resolution strategy: use the default session + default worker.
 * The first known target id is treated as "current". This is a pilot
 * — multi-tab dispatch is out of scope for issue #889. When no tab
 * is registered, we return `null` and the replay handler short-circuits
 * with `skill_no_active_tab`.
 *
 * Contract assertion strategy: defer to `runContractAssertions` from
 * `src/pilot/runtime/` when the skill record carries a `contracts`
 * payload under `steps.contracts`. Otherwise return `{ pass: true }`
 * — the replay handler already enforces domain and step-level success,
 * which is sufficient when no contract is attached.
 */

import type { Page } from 'puppeteer-core';

import { getSessionManager } from '../../session-manager.js';
import { assertDomainAllowed } from '../../security/domain-guard.js';
import type { SkillRecord } from '../../core/skill-memory/index.js';

import type {
  ActionStepResult,
  ContractAssertionVerdict,
  CurrentTabInfo,
  ReplayActionStep,
} from './replay.js';

const DEFAULT_WORKER_ID = 'default';

/**
 * Default tab resolver. Walks the caller's session (passed by the synth
 * handler from the MCP request envelope) and returns the first known
 * target on its default worker. Returns `null` when no tab has been
 * created yet (the replay handler then emits `skill_no_active_tab`).
 *
 * Codex P1 on PR #930: this previously used a hardcoded `"default"`
 * session id, which meant every concurrent agent shared whatever tab
 * the default session happened to have open. Now scoped per-session.
 */
export async function defaultResolveCurrentTab(sessionId: string): Promise<CurrentTabInfo | null> {
  try {
    const sessionManager = getSessionManager();
    const targetIds = sessionManager.getWorkerTargetIds(sessionId, DEFAULT_WORKER_ID);
    if (targetIds.length === 0) return null;
    const targetId = targetIds[0];
    const page = await sessionManager.getPage(
      sessionId,
      targetId,
      DEFAULT_WORKER_ID,
      'dynamic-skills-replay',
    );
    if (!page) return null;
    let url: string;
    try {
      url = page.url();
    } catch {
      return null;
    }
    if (!url || url.length === 0) return null;
    return { tabId: targetId, url };
  } catch (err) {
    console.error(
      `[dynamic-skills] defaultResolveCurrentTab failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Drive one recorded step against the current page. Each kind maps to
 * a single Puppeteer call; we keep the surface intentionally small so
 * the replay path is auditable.
 */
export async function defaultRunStep(
  tab: CurrentTabInfo,
  step: ReplayActionStep,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<ActionStepResult> {
  let page: Page | null;
  try {
    page = await getSessionManager().getPage(
      sessionId,
      tab.tabId,
      DEFAULT_WORKER_ID,
      'dynamic-skills-replay',
    );
  } catch (err) {
    return {
      ok: false,
      code: 'page_unavailable',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!page) {
    return { ok: false, code: 'page_unavailable', message: `no page for tab ${tab.tabId}` };
  }

  try {
    switch (step.kind) {
      case 'navigate':
        assertDomainAllowed(step.url);
        await page.goto(step.url, { waitUntil: 'load' });
        return { ok: true };
      case 'fill': {
        const value = args[step.valueParam];
        if (typeof value !== 'string') {
          return {
            ok: false,
            code: 'missing_param',
            message: `param "${step.valueParam}" missing or not a string`,
          };
        }
        await page.waitForSelector(step.selector, { timeout: 5000 });
        // Clear before typing so re-runs do not append.
        await page.$eval(step.selector, (el) => {
          (el as HTMLInputElement).value = '';
        });
        await page.type(step.selector, value);
        return { ok: true };
      }
      case 'click':
        await page.waitForSelector(step.selector, { timeout: 5000 });
        await page.click(step.selector);
        return { ok: true };
      case 'wait':
        await new Promise<void>((resolve) => setTimeout(resolve, step.ms));
        return { ok: true };
      case 'wait_for':
        await page.waitForSelector(step.selector, {
          timeout: typeof step.timeout_ms === 'number' ? step.timeout_ms : 5000,
        });
        return { ok: true };
      default: {
        // Exhaustiveness guard — TypeScript verifies this is `never`.
        const exhaustive: never = step;
        return { ok: false, code: 'unsupported_step', message: `unknown step kind: ${JSON.stringify(exhaustive)}` };
      }
    }
  } catch (err) {
    return {
      ok: false,
      code: 'step_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Default contract assertion.
 *
 * `skill.contractId` is normally an identifier string written by
 * `oc_skill_record` (e.g. `ctr_login_success`). It is NOT a runnable page
 * expression — feeding it straight into Runtime.evaluate produces a
 * ReferenceError and would force every replay to fail post-condition even
 * when the steps themselves succeed (Codex P1 on PR #930 fixup).
 *
 * Dispatch:
 *   • no contractId           → pass with reason `no_contract`
 *   • contractId starts with `js:`  → evaluate the rest of the string as
 *                                     a JS expression in the active page;
 *                                     pass iff the expression resolves to
 *                                     boolean `true`. This is the explicit
 *                                     opt-in for inline checks.
 *   • any other identifier    → fail with reason
 *                               `contract_runtime_not_wired` — the
 *                               orchestrator/curator family will later
 *                               inject a richer verifier via the
 *                               `assertContract` override. We fail closed
 *                               rather than report a false-positive success
 *                               for normal recorded contract identifiers.
 *
 * Together this matches the "no false positives, no false negatives"
 * contract codex asked for: only explicit JS expressions are graded;
 * bare IDs are returned as "deferred to a real verifier".
 */
const CONTRACT_EVAL_TIMEOUT_MS = 2_000;
const JS_EXPR_PREFIX = 'js:';

export async function defaultAssertContract(
  skill: SkillRecord,
  tab: CurrentTabInfo,
  sessionId: string,
): Promise<ContractAssertionVerdict> {
  const contractId = (skill.contractId ?? '').trim();
  if (contractId.length === 0) {
    return { pass: true, reason: 'no_contract' };
  }
  if (!contractId.startsWith(JS_EXPR_PREFIX)) {
    // Bare identifier — no inline verifier. Fail closed instead of treating an
    // unevaluated recorded contract as success.
    return { pass: false, reason: 'contract_runtime_not_wired' };
  }
  const expr = contractId.slice(JS_EXPR_PREFIX.length).trim();
  if (expr.length === 0) {
    return { pass: false, reason: 'contract_eval_empty_expression' };
  }
  try {
    const sessionManager = getSessionManager();
    const page = await sessionManager.getPage(
      sessionId,
      tab.tabId,
      DEFAULT_WORKER_ID,
      'dynamic-skills-assert',
    );
    if (!page) {
      return { pass: false, reason: 'contract_eval_no_page' };
    }
    const cdpSession = await page.target().createCDPSession();
    try {
      const result = (await cdpSession.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        timeout: CONTRACT_EVAL_TIMEOUT_MS,
      })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
      if (result.exceptionDetails) {
        return {
          pass: false,
          reason: `contract_eval_threw: ${result.exceptionDetails.text ?? 'unknown'}`,
        };
      }
      const value = result?.result?.value;
      if (value === true) return { pass: true };
      return { pass: false, reason: `contract_eval_falsey: got ${JSON.stringify(value)}` };
    } finally {
      try {
        await cdpSession.detach();
      } catch {
        /* detach is best-effort */
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { pass: false, reason: `contract_eval_failed: ${message}` };
  }
}
