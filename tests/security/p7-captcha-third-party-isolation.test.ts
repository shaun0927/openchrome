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

const PROVIDER_MODULE_KEYS = [
  '/captcha/providers/twocaptcha',
  '/captcha/providers/anticaptcha',
  '/captcha/providers/capsolver',
];

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
  return Object.keys(require.cache).filter(k =>
    PROVIDER_MODULE_KEYS.some(suffix => k.includes(suffix)),
  );
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
