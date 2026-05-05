/**
 * Headless mode resolver — single source of truth for the headed-vs-headless
 * decision when openchrome auto-launches Chrome.
 *
 * The default flipped from 'headless' to 'headed' in #657 because headless
 * Chrome is materially more prone to silent hangs, anti-bot blocks, and
 * login-flow failures. Users who genuinely want headless (CI, Docker, kiosk)
 * opt in explicitly via --headless or OPENCHROME_HEADLESS=1.
 */

export type HeadlessMode = 'headed' | 'headless';

export interface HeadlessOptions {
  /** Explicit opt-in to headless. */
  headless?: boolean;
  /** Back-compat alias: explicit opt-in to headed. */
  visible?: boolean;
}

export interface HeadlessEnv {
  OPENCHROME_HEADLESS?: string;
}

export interface HeadlessConfig {
  headless?: boolean;
}

export class HeadlessFlagConflictError extends Error {
  constructor() {
    super('--headless and --visible cannot both be specified');
    this.name = 'HeadlessFlagConflictError';
  }
}

/**
 * Resolves headed-vs-headless intent from CLI flags, env vars, and config.
 *
 * Precedence (highest first):
 *   1. CLI --headless          (explicit headless)
 *   2. CLI --visible           (explicit headed; back-compat alias)
 *   3. OPENCHROME_HEADLESS env (1/true/yes → headless; 0/false/no → headed)
 *   4. config.headless         (persisted preference)
 *   5. default                 → 'headed' (new default; was 'headless' before #657)
 *
 * Throws HeadlessFlagConflictError when both --headless and --visible are set.
 */
export function resolveHeadlessMode(
  options: HeadlessOptions,
  env: HeadlessEnv,
  config: HeadlessConfig,
): HeadlessMode {
  if (options.headless === true && options.visible === true) {
    throw new HeadlessFlagConflictError();
  }

  if (options.headless === true) return 'headless';
  if (options.visible === true) return 'headed';

  const envValue = env.OPENCHROME_HEADLESS;
  if (typeof envValue === 'string' && envValue.length > 0) {
    const normalized = envValue.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return 'headless';
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return 'headed';
    // Unknown env value: ignore, fall through to config / default.
  }

  if (typeof config.headless === 'boolean') {
    return config.headless ? 'headless' : 'headed';
  }

  return 'headed';
}
