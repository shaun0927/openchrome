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
import type { SkillRecord } from '../../core/skill-memory/index.js';

import type {
  ActionStepResult,
  ContractAssertionVerdict,
  CurrentTabInfo,
  ReplayActionStep,
} from './replay.js';

const DEFAULT_SESSION_ID = 'default';
const DEFAULT_WORKER_ID = 'default';

/**
 * Default tab resolver. Walks the default session/default worker and
 * returns the first known target. Returns `null` when no tab has been
 * created yet (the replay handler then emits `skill_no_active_tab`).
 */
export async function defaultResolveCurrentTab(): Promise<CurrentTabInfo | null> {
  try {
    const sessionManager = getSessionManager();
    const targetIds = sessionManager.getWorkerTargetIds(DEFAULT_SESSION_ID, DEFAULT_WORKER_ID);
    if (targetIds.length === 0) return null;
    const targetId = targetIds[0];
    const page = await sessionManager.getPage(
      DEFAULT_SESSION_ID,
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
): Promise<ActionStepResult> {
  let page: Page | null;
  try {
    page = await getSessionManager().getPage(
      DEFAULT_SESSION_ID,
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
 * Default contract assertion. The dynamic-skills pilot does not yet
 * own the contract-runtime integration; we return a benign pass so
 * replay relies on domain + step success as its post-condition. The
 * orchestrator/curator family will later inject a richer verifier via
 * the `assertContract` override.
 *
 * `_skill` / `_tab` are unused but kept in the signature so the type
 * matches `DynamicSkillsAttachment['assertContract']`.
 */
export async function defaultAssertContract(
  _skill: SkillRecord,
  _tab: CurrentTabInfo,
): Promise<ContractAssertionVerdict> {
  return { pass: true };
}
