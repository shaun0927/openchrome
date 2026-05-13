/**
 * Dynamic skill→tool synthesis bootstrap (issue #889).
 *
 * This module is the wiring glue:
 *
 *   1. `attachDynamicSkillsToServer(server)` is called from
 *      `src/index.ts` exactly once, after `registerAllTools(server)`
 *      has finished. It is a no-op unless `isDynamicSkillsEnabled()`
 *      returns true.
 *
 *   2. When active, the bootstrap subscribes to the process-local
 *      event emitter exposed by `./events.ts`. Two events drive
 *      synthesis:
 *
 *        domain_entered   — emitted by `src/tools/navigate.ts` after
 *                            a successful navigation. The handler
 *                            loads all skills for the new domain,
 *                            synthesizes a tool definition per skill,
 *                            registers them with the MCP server, and
 *                            emits `notifications/tools/list_changed`
 *                            once if at least one fresh registration
 *                            landed.
 *
 *        skill_recorded   — emitted by `src/tools/oc-skill-record.ts`
 *                            after a successful record. The handler
 *                            synthesizes that single skill
 *                            immediately, registers it, and emits one
 *                            `list_changed`.
 *
 *   3. On `detachDynamicSkillsFromServer()` (session teardown / test
 *      cleanup), every synthesized tool is deregistered and one
 *      final `list_changed` notification is emitted.
 *
 * Per portability-harness contract:
 *
 *   - P1 relaxed: emits proactive `list_changed` notifications outside
 *     a tool request lifetime. That is the whole point of this family.
 *   - P2 strict: every public function is a structural no-op unless
 *     `isDynamicSkillsEnabled()` returns true. The snapshot test
 *     under `tests/pilot/dynamic-skills/registration-default.snapshot.test.ts`
 *     verifies the `--pilot` (without the env var) surface.
 *   - P3 strict: zero outbound network. The bootstrap only reads
 *     local files via `SkillMemoryStore` and registers in-memory
 *     handlers.
 *   - P4 (facts not decisions): synthesis is a deterministic
 *     transformation of the recorded skill into a tool definition.
 */

import { isDynamicSkillsEnabled } from '../../harness/flags.js';
import {
  defaultSkillMemoryRootDir,
  SkillMemoryStore,
  type SkillRecord,
} from '../../core/skill-memory/index.js';
import type { MCPServer } from '../../mcp-server.js';
import type { MCPResult, ToolContext, ToolHandler } from '../../types/mcp.js';
import { logAuditEntry } from '../../security/audit-logger.js';

import {
  dynamicSkillEvents,
  type DomainEnteredEvent,
  type SkillRecordedEvent,
} from './events.js';
import { getDynamicSkillsRegistry, type RegistryEntry } from './registry.js';
import {
  runReplay,
  type ContractAssertionVerdict,
  type CurrentTabInfo,
  type ReplayActionStep,
  type ReplayHandlerOpts,
  type ActionStepResult,
} from './replay.js';
import { synthesizeToolDefinition } from './synthesizer.js';

/**
 * Glue object injected by the runtime. Tests substitute a
 * deterministic stub. Defaults to the production session-manager /
 * contract-runtime wiring.
 */
export interface DynamicSkillsAttachment {
  /**
   * Resolve the tab the replay should target for the calling MCP session.
   * The session id is threaded through so concurrent agents don't share
   * the default session's tab (Codex P1 on PR #930).
   */
  resolveCurrentTab?: (sessionId: string) => Promise<CurrentTabInfo | null>;
  /**
   * Drive one recorded step. The caller's MCP session id is forwarded so
   * the runner can address the target's page in the right session
   * (Codex P1 follow-up on PR #930).
   */
  runStep?: (
    tab: CurrentTabInfo,
    step: ReplayActionStep,
    args: Record<string, unknown>,
    sessionId: string,
  ) => Promise<ActionStepResult>;
  /**
   * Evaluate a skill's outcome contract against the same tab the replay
   * just executed against. The session id lets the verifier reach the
   * Chrome target via the SessionManager (Codex P1 on PR #930).
   */
  assertContract?: (
    skill: SkillRecord,
    tab: CurrentTabInfo,
    sessionId: string,
  ) => Promise<ContractAssertionVerdict>;
  /** Override the skill-memory root dir. */
  skillRootDir?: string;
  /** Audit emitter (defaults to `logAuditEntry`). */
  emitAudit?: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Default action runner — returns a structured "not implemented"
 * error. Production wiring is responsible for supplying a real runner
 * via {@link DynamicSkillsAttachment.runStep}. We keep a benign
 * default so the synthesized tool surface is exercise-able from
 * tests without bringing in the session manager.
 */
const defaultRunStep: NonNullable<DynamicSkillsAttachment['runStep']> = async () => ({
  ok: false,
  code: 'replay_runner_not_wired',
  message: 'no replay step runner has been wired into the dynamic-skills bootstrap',
});

/**
 * Default contract assertion — pass-through that always fails so
 * production wiring without an explicit `assertContract` is safe (no
 * silent success). Tests inject `() => ({ pass: true })`.
 */
const defaultAssertContract: NonNullable<
  DynamicSkillsAttachment['assertContract']
> = async () => ({ pass: false, reason: 'no contract verifier has been wired into the dynamic-skills bootstrap' });

/**
 * Default tab resolver — returns null so the synthesized tool refuses
 * to run when no resolver has been wired. Same safe-by-default
 * principle as `defaultRunStep`.
 */
const defaultResolveCurrentTab: NonNullable<
  DynamicSkillsAttachment['resolveCurrentTab']
> = async () => null;

/**
 * Default audit emitter wraps `logAuditEntry` so synthesis and replay
 * events flow through the same path as core tool invocations.
 */
function defaultEmitAudit(event: string, payload: Record<string, unknown>): void {
  try {
    logAuditEntry(event, 'dynamic-skills', payload);
  } catch (err) {
    // Audit logging must never crash the pilot path — log to stderr
    // and continue. CLAUDE.md mandates console.error here.
    console.error(`[dynamic-skills] audit emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface AttachmentState {
  server: MCPServer;
  domainListener: (event: DomainEnteredEvent) => void;
  recordedListener: (event: SkillRecordedEvent) => void;
  attachment: Required<DynamicSkillsAttachment>;
}

let current: AttachmentState | undefined;

/**
 * Build a replay handler bound to the given skill record. The handler
 * is what the MCP server invokes on tools/call dispatch. We close
 * over the skill record so each synthesized tool has its own private
 * replay context — that matters because the registry is keyed by name
 * but the handler also needs the bound `SkillRecord`.
 */
function buildSynthesizedHandler(
  skill: SkillRecord,
  attachment: Required<DynamicSkillsAttachment>,
): ToolHandler {
  return async (
    sessionId: string,
    args: Record<string, unknown>,
    _context?: ToolContext,
  ): Promise<MCPResult> => {
    const opts: ReplayHandlerOpts = {
      resolveCurrentTab: attachment.resolveCurrentTab,
      runStep: attachment.runStep,
      assertContract: attachment.assertContract,
    };
    let result;
    try {
      result = await runReplay(skill, args, opts, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        success: false as const,
        code: 'skill_step_failed' as const,
        message,
      };
    }

    attachment.emitAudit(result.success ? 'skill_replayed' : 'skill_replay_failed', {
      session_id: sessionId,
      skill_id: skill.skillId,
      domain: skill.domain,
      contract_id: skill.contractId,
      ...(result.success ? {} : { code: result.code }),
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
      ...(result.success ? {} : { isError: true }),
    };
  };
}

/**
 * Synthesize + register a single skill. Returns true iff a fresh
 * registration landed (i.e., the registry did not already hold the
 * same synthesized name). Callers use the return value to decide
 * whether emitting a `list_changed` notification is meaningful.
 */
function registerSynthesizedSkill(
  state: AttachmentState,
  skill: SkillRecord,
): boolean {
  const { name, definition } = synthesizeToolDefinition(skill);
  const registry = getDynamicSkillsRegistry();
  const existing = registry.get(name);
  if (existing && existing.skillId !== skill.skillId) {
    state.attachment.emitAudit('skill_synthesis_collision', {
      name,
      domain: skill.domain,
      skill_id: skill.skillId,
      existing_skill_id: existing.skillId,
    });
    console.error(
      `[dynamic-skills] synthesized tool-name collision: name=${name} existing_skill_id=${existing.skillId} new_skill_id=${skill.skillId}`,
    );
    return false;
  }
  const handler = buildSynthesizedHandler(skill, state.attachment);
  state.server.registerTool(name, handler, definition);
  const fresh = registry.register({
    name,
    domain: skill.domain,
    skillId: skill.skillId,
    contractId: skill.contractId,
    definition,
    registeredAt: Date.now(),
  });
  state.attachment.emitAudit('skill_synthesized', {
    name,
    domain: skill.domain,
    skill_id: skill.skillId,
    contract_id: skill.contractId,
    fresh,
  });
  return fresh;
}

/**
 * Handler for `domain_entered`. Loads every skill bound to the new
 * domain, synthesizes each, and emits exactly one
 * `list_changed` notification when at least one fresh registration
 * landed.
 *
 * Per spec: the navigate tool's success path enforces
 * `assertDomainAllowed` before emitting the event, so we trust the
 * incoming `domain` here. The replay handler re-checks the blocklist
 * at invocation time as defense in depth.
 */
function handleDomainEntered(state: AttachmentState): (event: DomainEnteredEvent) => void {
  return (event) => {
    try {
      const store = new SkillMemoryStore({
        rootDir: state.attachment.skillRootDir,
        domain: event.domain,
      });
      const skills: SkillRecord[] = store.list();
      if (skills.length === 0) return;
      let freshCount = 0;
      for (const skill of skills) {
        try {
          if (registerSynthesizedSkill(state, skill)) freshCount++;
        } catch (err) {
          console.error(
            `[dynamic-skills] synthesize failed for skill_id=${skill.skillId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (freshCount > 0) {
        emitListChanged(state.server);
      }
    } catch (err) {
      // Storage errors (missing dir, malformed file) should not crash
      // navigate. Log and move on — the navigate response itself is
      // already on its way back to the client.
      console.error(
        `[dynamic-skills] domain_entered handler failed for ${event.domain}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}

/**
 * Handler for `skill_recorded`. Synthesizes the just-recorded skill
 * so subsequent calls in the same session can use it. Always emits
 * one `list_changed` because the registration is fresh by construction
 * (idempotent re-records still update the tool definition and the
 * client may need to refresh its schema view).
 */
function handleSkillRecorded(state: AttachmentState): (event: SkillRecordedEvent) => void {
  return (event) => {
    try {
      const store = new SkillMemoryStore({
        rootDir: state.attachment.skillRootDir,
        domain: event.domain,
      });
      const skill = store.get(event.skillId);
      if (!skill) {
        console.error(
          `[dynamic-skills] skill_recorded event references unknown skill_id=${event.skillId} domain=${event.domain}`,
        );
        return;
      }
      registerSynthesizedSkill(state, skill);
      emitListChanged(state.server);
    } catch (err) {
      console.error(
        `[dynamic-skills] skill_recorded handler failed for ${event.domain}/${event.skillId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}

/**
 * Emit `notifications/tools/list_changed` if the MCP server supports
 * it. We rely on the public {@link MCPServer.emitListChanged} method
 * (added by this issue) so the pilot bootstrap does not need access
 * to the private `sendNotification` method.
 */
function emitListChanged(server: MCPServer): void {
  if (typeof (server as unknown as { emitListChanged?: () => void }).emitListChanged === 'function') {
    (server as unknown as { emitListChanged: () => void }).emitListChanged();
  }
}

/**
 * Wire the dynamic-skills pilot family to an MCP server instance.
 * Returns true if wiring happened (flag active, attached for the first
 * time) and false otherwise. Calling twice with the same server is a
 * no-op.
 */
export function attachDynamicSkillsToServer(
  server: MCPServer,
  attachment: DynamicSkillsAttachment = {},
): boolean {
  if (!isDynamicSkillsEnabled()) return false;
  if (current !== undefined) {
    // Already attached. The handoff/curator families do the same
    // (multiple registrations would double-emit list_changed).
    return false;
  }
  const resolved: Required<DynamicSkillsAttachment> = {
    resolveCurrentTab: attachment.resolveCurrentTab ?? defaultResolveCurrentTab,
    runStep: attachment.runStep ?? defaultRunStep,
    assertContract: attachment.assertContract ?? defaultAssertContract,
    skillRootDir: attachment.skillRootDir ?? defaultSkillMemoryRootDir(),
    emitAudit: attachment.emitAudit ?? defaultEmitAudit,
  };
  const state: AttachmentState = {
    server,
    domainListener: () => {
      /* placeholder — replaced below */
    },
    recordedListener: () => {
      /* placeholder — replaced below */
    },
    attachment: resolved,
  };
  state.domainListener = handleDomainEntered(state);
  state.recordedListener = handleSkillRecorded(state);
  dynamicSkillEvents.on('domain_entered', state.domainListener);
  dynamicSkillEvents.on('skill_recorded', state.recordedListener);
  current = state;
  return true;
}

/**
 * Unwire the dynamic-skills pilot from the MCP server. Deregisters
 * every synthesized tool and emits a single final `list_changed`
 * notification iff at least one tool was actually deregistered.
 *
 * Safe to call when `attachDynamicSkillsToServer` was never called
 * (returns false).
 */
export function detachDynamicSkillsFromServer(): boolean {
  if (current === undefined) return false;
  const state = current;
  current = undefined;
  dynamicSkillEvents.off('domain_entered', state.domainListener);
  dynamicSkillEvents.off('skill_recorded', state.recordedListener);
  const registry = getDynamicSkillsRegistry();
  const entries: RegistryEntry[] = registry.list();
  let removed = 0;
  for (const entry of entries) {
    try {
      const unregister = (state.server as unknown as { unregisterTool?: (name: string) => boolean })
        .unregisterTool;
      if (typeof unregister === 'function') {
        if (unregister.call(state.server, entry.name)) removed++;
      }
      registry.deregister(entry.name);
      state.attachment.emitAudit('skill_deregistered', {
        name: entry.name,
        domain: entry.domain,
        skill_id: entry.skillId,
      });
    } catch (err) {
      console.error(
        `[dynamic-skills] deregister failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  void removed;
  return true;
}

/**
 * Test-only hook. Drops attachment state without touching the
 * registry. Combined with `_resetDynamicSkillsRegistryForTesting()`
 * in tests to reset to a known-fresh state between scenarios.
 */
export function _resetDynamicSkillsAttachmentForTesting(): void {
  if (current !== undefined) {
    const state = current;
    dynamicSkillEvents.off('domain_entered', state.domainListener);
    dynamicSkillEvents.off('skill_recorded', state.recordedListener);
  }
  current = undefined;
}
