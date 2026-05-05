/**
 * Launch mode resolver (#659).
 *
 * Decides how openchrome should obtain a Chrome to drive when the user
 * specifies a profile.
 *
 * Three modes:
 *
 *   'auto'      — default; openchrome probes the configured remote-debugging
 *                 port first and attaches if Chrome is already there;
 *                 otherwise spawns its own Chrome. (Existing behavior — no
 *                 change for users who don't set anything.)
 *
 *   'attach'    — opt-in; openchrome MUST attach to an existing Chrome that
 *                 the user pre-launched with `--remote-debugging-port`. If
 *                 nothing is listening, the launcher returns a structured
 *                 error (`AttachConsentRequiredError`) so the agent can
 *                 surface a helpful next-step message instead of silently
 *                 spawning a clean-room copy.
 *
 *   'isolated'  — opt-in; openchrome ALWAYS spawns its own Chrome with the
 *                 isolated `--user-data-dir` even if a Chrome is already
 *                 listening on the debug port. Useful for clean-room
 *                 scraping where you want a guaranteed fresh profile.
 *
 * Important policy decisions baked in here (see #659 PR description):
 *   1. Default stays 'auto'. No behavior change for existing users.
 *   2. We NEVER auto-restart the user's Chrome to enable a debug port.
 *      If the user wants attach mode, they must launch Chrome themselves
 *      with `--remote-debugging-port=NNNN`. The follow-up "automatic
 *      restart with consent" workflow is deferred to a separate issue.
 *   3. When attach mode is on AND the port isn't listening, we surface a
 *      loud, structured error rather than silently falling back —
 *      otherwise the user would never realise their attach attempt
 *      didn't take.
 */

export type LaunchMode = 'auto' | 'attach' | 'isolated';

export interface LaunchModeOptions {
  /** Per-call override (highest priority). */
  launchMode?: LaunchMode | string;
}

export interface LaunchModeEnv {
  OPENCHROME_LAUNCH_MODE?: string;
}

export interface LaunchModeConfig {
  chromeLaunchMode?: LaunchMode | string;
}

export class InvalidLaunchModeError extends Error {
  constructor(value: string, source: 'cli' | 'env' | 'config') {
    super(`Invalid launch mode "${value}" (from ${source}); expected 'auto' | 'attach' | 'isolated'.`);
    this.name = 'InvalidLaunchModeError';
  }
}

const VALID: ReadonlySet<LaunchMode> = new Set(['auto', 'attach', 'isolated']);

function parse(value: string | undefined, source: 'cli' | 'env' | 'config'): LaunchMode | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const normalized = trimmed.toLowerCase();
  if (!VALID.has(normalized as LaunchMode)) {
    throw new InvalidLaunchModeError(trimmed, source);
  }
  return normalized as LaunchMode;
}

/**
 * Resolves the launch mode from CLI options, env, and config.
 * Precedence (highest first):
 *   1. options.launchMode    (per-call override)
 *   2. OPENCHROME_LAUNCH_MODE env var
 *   3. globalConfig.chromeLaunchMode
 *   4. 'auto'                 (default)
 *
 * Throws `InvalidLaunchModeError` for unrecognised values rather than
 * silently coercing — surfaces typos in env vars and config files.
 */
export function resolveLaunchMode(
  options: LaunchModeOptions = {},
  env: LaunchModeEnv = {},
  config: LaunchModeConfig = {},
): LaunchMode {
  const fromCli = parse(typeof options.launchMode === 'string' ? options.launchMode : undefined, 'cli');
  if (fromCli) return fromCli;

  const fromEnv = parse(env.OPENCHROME_LAUNCH_MODE, 'env');
  if (fromEnv) return fromEnv;

  const fromConfig = parse(typeof config.chromeLaunchMode === 'string' ? config.chromeLaunchMode : undefined, 'config');
  if (fromConfig) return fromConfig;

  return 'auto';
}

/**
 * Structured error: surface to the agent when attach is required but no
 * Chrome is listening on the debug port. The agent's logs / tool output
 * carry the helpful next steps so the user can react out-of-band.
 *
 * NOTE: openchrome runs as an MCP server over stdio with no human at the
 * other end, so we cannot interactively prompt. The error message is the
 * UX surface.
 */
export class AttachConsentRequiredError extends Error {
  readonly errorCode = 'attach_consent_required' as const;
  readonly port: number;
  readonly hint: string;

  constructor(port: number) {
    const hint =
      `Set OPENCHROME_LAUNCH_MODE=auto (default) to spawn a fresh Chrome instead, ` +
      `OR launch Chrome yourself with --remote-debugging-port=${port} so openchrome can attach to it. ` +
      `openchrome will NOT close or restart your existing Chrome automatically.`;
    super(
      `attach mode is enabled but no Chrome is listening on debug port ${port}. ${hint}`,
    );
    this.name = 'AttachConsentRequiredError';
    this.port = port;
    this.hint = hint;
  }
}
