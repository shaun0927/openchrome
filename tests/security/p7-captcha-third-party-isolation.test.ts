/// <reference types="jest" />

/**
 * P7 audit — third-party CAPTCHA credential isolation.
 *
 * #1359 §P7 (core boring, pilot experimental) and the explicit non-goal
 * "no mandatory third-party credentials at boot" require that the core
 * captcha module:
 *
 *   1. boots without any OPENCHROME_CAPTCHA_* environment variable,
 *   2. exposes `isConfigured() === false` and `isAutoSolveEnabled() === false`
 *      in that state,
 *   3. does not load any solver provider module (`2captcha`, `anticaptcha`,
 *      `capsolver`) until a provider is explicitly named via env vars,
 *   4. surfaces an explicit "no solver configured" facts-only response from
 *      `handleCaptcha`, without making any network call or import.
 *
 * These tests codify those invariants so a future refactor cannot silently
 * make captcha solving load-bearing on core.
 */

const ENV_KEYS = [
  'OPENCHROME_CAPTCHA_PROVIDER',
  'OPENCHROME_CAPTCHA_API_KEY',
  'OPENCHROME_CAPTCHA_AUTO_SOLVE',
  'OPENCHROME_CAPTCHA_DAILY_LIMIT',
] as const;

// Auto-derived from the providers directory so a future provider file is
// guarded automatically. Hardcoding the list would silently miss a new
// `src/captcha/providers/foo.ts` and let it escape the audit. The suffix
// is path-separator-agnostic ("captcha/providers/foo" is matched after
// normalizing backslashes to forward slashes) so the test behaves
// identically on POSIX and Windows runners.
const PROVIDER_DIR = require('path').join(__dirname, '..', '..', 'src', 'captcha', 'providers');
const PROVIDER_MODULE_KEYS = require('fs')
  .readdirSync(PROVIDER_DIR)
  .filter((f: string) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
  .map((f: string) => `captcha/providers/${f.replace(/\.(ts|js)$/, '')}`);

function clearCaptchaEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreCaptchaEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function providerModulesInRequireCache(): string[] {
  return Object.keys(require.cache).filter((k: string) => {
    // Windows require.cache keys use `\` separators; normalize before the
    // substring check so the same suffix matches on POSIX and Windows.
    const normalized = k.replace(/\\/g, '/');
    return (PROVIDER_MODULE_KEYS as string[]).some((suffix: string) =>
      normalized.includes(suffix),
    );
  });
}

describe('P7: captcha module boots without third-party credentials', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = clearCaptchaEnv();
    jest.resetModules();
  });

  afterEach(() => {
    restoreCaptchaEnv(savedEnv);
  });

  // Positive control: prove the require.cache probe actually sees provider
  // modules when they are loaded. If this test ever fails, every other test
  // in this file is silently vacuous — so it must pass before the laziness
  // assertions are meaningful.
  test('probe self-check — explicitly requiring a provider IS detected in require.cache', () => {
    jest.resetModules();
    expect(providerModulesInRequireCache()).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/captcha/providers/twocaptcha');
    const loaded = providerModulesInRequireCache();
    expect(loaded.length).toBeGreaterThan(0);
  });

  // Structural invariant: the auto-derived provider list must be non-empty.
  // If `src/captcha/providers/` is ever emptied or renamed without a parallel
  // doc update, the rest of this audit becomes vacuous — fail loudly here.
  test('provider directory exists and at least one provider is enumerated', () => {
    expect(PROVIDER_MODULE_KEYS.length).toBeGreaterThan(0);
  });

  test('SolverRegistry construction does not throw or load provider modules', async () => {
    // Reset the require cache so we observe a clean boot.
    jest.resetModules();
    const before = providerModulesInRequireCache();

    const { SolverRegistry } = await import('../../src/captcha/solver-registry');
    const registry = new SolverRegistry();

    expect(registry).toBeDefined();
    expect(registry.isConfigured()).toBe(false);
    expect(registry.isAutoSolveEnabled()).toBe(false);

    // No provider module should have been pulled in just by constructing
    // the registry.
    const after = providerModulesInRequireCache();
    expect(after).toEqual(before);
  });

  test('initialize() with no env returns without loading any provider module', async () => {
    jest.resetModules();

    const { SolverRegistry } = await import('../../src/captcha/solver-registry');
    const registry = new SolverRegistry();
    await registry.initialize();

    expect(registry.isConfigured()).toBe(false);
    expect(registry.isAutoSolveEnabled()).toBe(false);

    const loaded = providerModulesInRequireCache();
    expect(loaded).toEqual([]);
  });

  test('isAutoSolveEnabled() stays false unless BOTH provider key and auto-solve flag are set', async () => {
    jest.resetModules();
    const { SolverRegistry } = await import('../../src/captcha/solver-registry');

    // Only auto-solve flag — still no provider/key → off.
    process.env.OPENCHROME_CAPTCHA_AUTO_SOLVE = 'true';
    let registry = new SolverRegistry();
    await registry.initialize();
    expect(registry.isAutoSolveEnabled()).toBe(false);

    // Only provider name + key — auto-solve flag missing → off.
    delete process.env.OPENCHROME_CAPTCHA_AUTO_SOLVE;
    process.env.OPENCHROME_CAPTCHA_PROVIDER = '2captcha';
    process.env.OPENCHROME_CAPTCHA_API_KEY = 'fake-key-only-used-for-shape-check';
    jest.resetModules();
    const { SolverRegistry: SolverRegistryB } = await import('../../src/captcha/solver-registry');
    registry = new SolverRegistryB();
    // Skip initialize() so we don't load the provider module in this test.
    expect(registry.isAutoSolveEnabled()).toBe(false);
  });

  test('handleCaptcha returns a facts-only "no solver configured" response and loads no provider', async () => {
    jest.resetModules();

    const { handleCaptcha } = await import('../../src/captcha/handler');
    const { waitForSolverReady } = await import('../../src/captcha/solver-registry');
    await waitForSolverReady();

    const fakePage: any = {
      url: () => 'https://example.com/',
      evaluate: async () => null,
    };

    const result = await handleCaptcha(fakePage, {
      type: 'captcha',
      captchaType: 'recaptcha_v2',
    } as any);

    expect(result.solved).toBe(false);
    expect(result.error).toMatch(/no captcha solver configured/i);

    const loaded = providerModulesInRequireCache();
    expect(loaded).toEqual([]);
  });

  test('importing the public barrel does not load any solver provider', async () => {
    jest.resetModules();
    await import('../../src/captcha');
    const loaded = providerModulesInRequireCache();
    expect(loaded).toEqual([]);
  });
});
