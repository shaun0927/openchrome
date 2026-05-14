/// <reference types="jest" />

import { captureEnvironment } from './environment';

describe('benchmark environment capture', () => {
  test('captures the required reproducibility fields', () => {
    const env = captureEnvironment();

    expect(typeof env.capturedAt).toBe('string');
    expect(Number.isNaN(Date.parse(env.capturedAt))).toBe(false);
    expect(typeof env.gitSha).toBe('string');
    expect(env.gitSha.length).toBeGreaterThan(0);
    expect(typeof env.gitDirty).toBe('boolean');
    expect(env.nodeVersion).toBe(process.version);
    expect(typeof env.os).toBe('string');
    expect(typeof env.arch).toBe('string');
    expect(typeof env.cpuModel).toBe('string');
    expect(env.cpuCount).toBeGreaterThan(0);
    expect(env.totalMemoryBytes).toBeGreaterThan(0);
    expect(typeof env.chromeVersion).toBe('string');
    expect(env.networkProfile).toBe('unthrottled');
  });

  test('records a custom network profile', () => {
    expect(captureEnvironment({ networkProfile: 'fast-3g' }).networkProfile).toBe('fast-3g');
  });

  test('embeds LLM metadata only when provided', () => {
    expect(captureEnvironment().llm).toBeUndefined();

    const withLlm = captureEnvironment({ llm: { model: 'claude-test', temperature: 0 } });
    expect(withLlm.llm).toEqual({ model: 'claude-test', temperature: 0 });
  });

  test('degrades gracefully — never throws', () => {
    expect(() => captureEnvironment({ chromePath: '/nonexistent/chrome/binary' })).not.toThrow();
    expect(captureEnvironment({ chromePath: '/nonexistent/chrome/binary' }).chromeVersion).toBe('unknown');
  });
});
