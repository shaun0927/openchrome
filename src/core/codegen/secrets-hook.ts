/**
 * Secrets-hook for codegen (issue #836).
 *
 * Provides a minimal contract so the codegen aggregator can capture the
 * *pre-substitution* argument form (where `${SECRET:NAME}` placeholders are
 * still tokens) rather than the post-substitution literal values. The full
 * substitution layer is owned by issue #834; until #834 lands the default
 * implementation returns `undefined`, which causes the aggregator to fall
 * back to recording the post-substitution args.
 *
 * Contract for #834: implementation must associate the original arg form
 * with a `toolCallId` (any opaque, monotonically-unique string per tool
 * call) at the moment of substitution, and return that exact value when
 * `getOriginalArgs(toolCallId)` is called from the codegen aggregator.
 *
 * TODO(#834): wire secrets-hook to MCP arg deserializer — replace the
 * default no-op implementation with the real lookup from
 * `src/security/secrets-substitution` once that module exists.
 */

/**
 * Interface a secrets-substitution module must implement to feed the
 * codegen aggregator pre-substitution args. Returning `undefined` means
 * "no original form recorded for this call" — codegen will use whatever
 * args it currently sees.
 */
export interface SecretsHook {
  getOriginalArgs(toolCallId: string): Record<string, unknown> | undefined;
}

let activeHook: SecretsHook | null = null;

/**
 * Install the secrets-hook implementation. Called once at module init by
 * #834's substitution layer (when that lands). The aggregator queries the
 * installed hook for every tool call; if no hook is installed, the
 * default no-op behaviour kicks in.
 *
 * @param hook  The hook implementation, or `null` to clear (used in tests).
 */
export function setSecretsHook(hook: SecretsHook | null): void {
  activeHook = hook;
}

/**
 * Return the current secrets-hook, or `null` when none is installed.
 * Exposed so the aggregator and tests can introspect.
 */
export function getSecretsHook(): SecretsHook | null {
  return activeHook;
}

/**
 * Convenience wrapper used by the aggregator. Returns the pre-substitution
 * args for the given tool call id, or `undefined` when no hook is installed
 * or the hook has no record for this id.
 *
 * The aggregator uses the return value as follows:
 *   - `undefined` → fall back to the args the tool handler already saw
 *     (post-substitution; may contain literal secrets if #834 is not yet
 *     wired). Pre-#834 builds therefore still produce a usable codegen
 *     file, with the known caveat tracked in Scenario 5 of #836.
 *   - `Record<string, unknown>` → use this exact object as the `args`
 *     field of the replay envelope. Snippet generators receive the same
 *     object, so placeholders like `${SECRET:NAME}` appear verbatim in
 *     the generated TS file.
 */
export function getOriginalArgs(
  toolCallId: string,
): Record<string, unknown> | undefined {
  if (!activeHook) return undefined;
  try {
    return activeHook.getOriginalArgs(toolCallId);
  } catch (err) {
    // The hook is third-party in spirit (#834 owns it). A throw must not
    // tear down the aggregator — codegen is a side-effect surface and
    // failure here is recoverable by falling back to post-substitution args.
    console.error(
      `[codegen] secrets-hook.getOriginalArgs threw for toolCallId=${toolCallId}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}
