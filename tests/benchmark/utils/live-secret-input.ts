import * as fs from 'fs';

export type LiveSecretProvider = 'anthropic' | 'openai';

export interface LiveSecretInputResult {
  applied: Array<{ provider: LiveSecretProvider; source: 'inline' | 'file' | 'stdin' | 'env-ref'; envName: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' }>;
}

const PROVIDER_ENV: Record<LiveSecretProvider, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name) || argv.some((arg) => arg.startsWith(`${name}=`));
}

function providerFromValue(raw: string | undefined, fallback: LiveSecretProvider): LiveSecretProvider {
  const value = raw ?? fallback;
  if (value === 'anthropic' || value === 'openai') return value;
  throw new Error(`benchmark API key provider must be anthropic or openai; got ${value}`);
}

function cleanSecret(raw: string, source: string): string {
  const value = raw.trim();
  if (!value) throw new Error(`benchmark API key from ${source} was empty`);
  if (/\s/.test(value)) throw new Error(`benchmark API key from ${source} contains whitespace`);
  return value;
}

function apply(env: NodeJS.ProcessEnv, provider: LiveSecretProvider, value: string, source: LiveSecretInputResult['applied'][number]['source'], applied: LiveSecretInputResult['applied']): void {
  const envName = PROVIDER_ENV[provider];
  env[envName] = cleanSecret(value, source);
  applied.push({ provider, source, envName });
}

/**
 * Applies benchmark-only secret input flags to an env object.
 *
 * This intentionally lives under tests/benchmark: it is a convenience for local
 * benchmark runs, not a product credential store. Values are copied into the
 * conventional provider env var for the lifetime of the Node process only.
 */
export function applyBenchmarkLiveSecretInputs(argv: string[], env: NodeJS.ProcessEnv = process.env): LiveSecretInputResult {
  const applied: LiveSecretInputResult['applied'] = [];

  const anthropicInline = flagValue(argv, '--anthropic-api-key');
  if (anthropicInline) apply(env, 'anthropic', anthropicInline, 'inline', applied);
  const openAiInline = flagValue(argv, '--openai-api-key');
  if (openAiInline) apply(env, 'openai', openAiInline, 'inline', applied);

  const anthropicFile = flagValue(argv, '--anthropic-api-key-file');
  if (anthropicFile) apply(env, 'anthropic', fs.readFileSync(anthropicFile, 'utf8'), 'file', applied);
  const openAiFile = flagValue(argv, '--openai-api-key-file');
  if (openAiFile) apply(env, 'openai', fs.readFileSync(openAiFile, 'utf8'), 'file', applied);

  const envRefProvider = flagValue(argv, '--api-key-env-provider');
  const envRefName = flagValue(argv, '--api-key-env');
  if (envRefName) {
    const provider = providerFromValue(envRefProvider, 'anthropic');
    const value = env[envRefName];
    if (!value) throw new Error(`--api-key-env ${envRefName} did not resolve to a non-empty environment variable`);
    apply(env, provider, value, 'env-ref', applied);
  }

  if (hasFlag(argv, '--api-key-stdin')) {
    const provider = providerFromValue(flagValue(argv, '--api-key-stdin'), 'anthropic');
    apply(env, provider, fs.readFileSync(0, 'utf8'), 'stdin', applied);
  }

  return { applied };
}

export function redactLiveSecretArgs(argv: string[]): string[] {
  const flagsWithValue = new Set(['--anthropic-api-key', '--openai-api-key']);
  const redacted: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsWithValue.has(arg)) {
      redacted.push(arg, '<redacted>');
      i++;
      continue;
    }
    if (arg.startsWith('--anthropic-api-key=') || arg.startsWith('--openai-api-key=')) {
      redacted.push(`${arg.split('=')[0]}=<redacted>`);
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}
