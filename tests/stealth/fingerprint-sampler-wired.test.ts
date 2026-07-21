import { describe, expect, it } from '@jest/globals';
import {
  getFingerprintSampleOverrideScript,
  isFingerprintSamplerEnabled,
} from '../../src/stealth/fingerprint-defense';
import { sampleFingerprint } from '../../src/stealth/fingerprint-sampler';

/**
 * Wiring test for the P8 pack. Codex flagged that `fingerprint-defense.ts`
 * and `human-behavior.ts` were unchanged, so the sampled tuple was never
 * injected — runtime effect was zero.
 *
 * These tests verify the two new integration surfaces:
 *   - `getFingerprintSampleOverrideScript(sample)` produces a JS source
 *     string that references the sampled values and defines them on
 *     Navigator/Screen/window prototypes.
 *   - `isFingerprintSamplerEnabled()` parses the env flag correctly.
 *
 * The client.ts wiring (see the diff at src/cdp/client.ts around the stealth
 * tab creation) then calls this pair inside the tab-open path.
 */
describe('FingerprintSampleOverrideScript', () => {
  it('embeds sampled values so they will be readable inside the page', () => {
    const sample = sampleFingerprint('deterministic-seed-1');
    const script = getFingerprintSampleOverrideScript(sample);
    // The script must contain the exact sampled UA / timezone / language so
    // that a page-side navigator.userAgent read returns the sampled value.
    expect(script).toContain(sample.userAgent);
    expect(script).toContain(sample.timezone);
    expect(script).toContain(sample.language);
    // hardwareConcurrency + deviceMemory need to be embedded as JSON
    // literals; check both appear in the encoded blob.
    expect(script).toContain(JSON.stringify(sample.hardwareConcurrency));
    expect(script).toContain(JSON.stringify(sample.deviceMemoryGB));
  });

  it('is deterministic for the same seed and covers >1 joint-table row across many seeds', () => {
    const a1 = sampleFingerprint('tab-A');
    const a2 = sampleFingerprint('tab-A');
    expect(a1.userAgent).toBe(a2.userAgent);
    expect(a1.timezone).toBe(a2.timezone);
    // Distribution property: across 40 varied seeds we must observe at
    // least two distinct joint rows. Otherwise the sampler is effectively
    // constant and would be trivially profileable — the exact failure
    // mode the P8 pack was written to fix.
    const uas = new Set<string>();
    for (let i = 0; i < 40; i++) {
      uas.add(sampleFingerprint(`seed-${i}`).userAgent);
    }
    expect(uas.size).toBeGreaterThan(1);
  });

  it('generated script is syntactically valid JavaScript', () => {
    const sample = sampleFingerprint('syntax-check');
    const script = getFingerprintSampleOverrideScript(sample);
    // Function constructor throws on invalid syntax — safest local
    // acceptance check without spinning up a real browser.
    expect(() => new Function(script)).not.toThrow();
  });

  it('script overrides run without throwing when executed in a sandbox-shaped global', () => {
    const sample = sampleFingerprint('exec-check');
    const script = getFingerprintSampleOverrideScript(sample);
    // Fake the minimum globals the script touches. If a defineProperty
    // path throws, the outer try/catch inside the script must swallow it.
    const sandbox: any = {
      Navigator: function () {},
      Screen: function () {},
      window: {},
      Intl: (globalThis as any).Intl,
    };
    sandbox.Navigator.prototype = {};
    sandbox.Screen.prototype = {};
    const fn = new Function(
      'Navigator', 'Screen', 'window', 'Intl',
      script,
    );
    expect(() => fn(sandbox.Navigator, sandbox.Screen, sandbox.window, sandbox.Intl)).not.toThrow();
    // Verify the Navigator getter was installed and returns the sampled UA.
    const nav = new sandbox.Navigator();
    expect(nav.userAgent).toBe(sample.userAgent);
    expect(nav.hardwareConcurrency).toBe(sample.hardwareConcurrency);
  });
});

describe('isFingerprintSamplerEnabled', () => {
  it('is off by default', () => {
    expect(isFingerprintSamplerEnabled({})).toBe(false);
  });
  it.each(['1', 'true', 'yes', 'on', 'TRUE'])('accepts %s as on', (v) => {
    expect(isFingerprintSamplerEnabled({ OPENCHROME_FINGERPRINT_SAMPLER: v })).toBe(true);
  });
  it.each(['0', 'false', 'off', ''])('rejects %s as off', (v) => {
    expect(isFingerprintSamplerEnabled({ OPENCHROME_FINGERPRINT_SAMPLER: v })).toBe(false);
  });
});
