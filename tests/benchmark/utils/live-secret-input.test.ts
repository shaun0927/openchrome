import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyBenchmarkLiveSecretInputs, redactLiveSecretArgs } from './live-secret-input';

describe('benchmark live secret input flags', () => {
  it('maps file-based provider keys into process-local env vars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-secret-'));
    const keyPath = path.join(dir, 'key.txt');
    fs.writeFileSync(keyPath, 'sk-test-file\n');
    const env: NodeJS.ProcessEnv = {};

    const result = applyBenchmarkLiveSecretInputs(['--openai-api-key-file', keyPath], env);

    expect(env.OPENAI_API_KEY).toBe('sk-test-file');
    expect(result.applied).toEqual([{ provider: 'openai', source: 'file', envName: 'OPENAI_API_KEY' }]);
  });

  it('maps an arbitrary env reference to the requested provider', () => {
    const env: NodeJS.ProcessEnv = { BENCH_KEY: 'sk-env-ref' };
    applyBenchmarkLiveSecretInputs(['--api-key-env', 'BENCH_KEY', '--api-key-env-provider', 'anthropic'], env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-env-ref');
  });

  it('redacts inline key values for diagnostics', () => {
    expect(redactLiveSecretArgs(['--openai-api-key', 'sk-secret', '--x', '--anthropic-api-key=sk-other'])).toEqual([
      '--openai-api-key', '<redacted>', '--x', '--anthropic-api-key=<redacted>',
    ]);
  });

  it('rejects empty and whitespace-bearing keys', () => {
    expect(() => applyBenchmarkLiveSecretInputs(['--anthropic-api-key', '  '], {})).toThrow(/empty/);
    expect(() => applyBenchmarkLiveSecretInputs(['--openai-api-key', 'sk test'], {})).toThrow(/whitespace/);
  });
});
