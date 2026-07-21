import { afterEach, describe, expect, it } from '@jest/globals';
import {
  envLaunchOnFirstUse,
  resolveEffectiveAutoLaunch,
  resetLaunchGateForTests,
  arm,
} from '../../src/chrome/launch-gate';

/**
 * Wiring test for the P3 pack CLI surface. Codex flagged that the promised
 * `--launch-on-first-use` CLI flag was absent — only the env var
 * OPENCHROME_LAUNCH_ON_FIRST_USE existed. This test pins the wiring the
 * CLI uses: when `--launch-on-first-use` is present, the CLI sets
 * OPENCHROME_LAUNCH_ON_FIRST_USE=1 so downstream consumers
 * (src/core/server.ts, src/cdp/client.ts, launch-gate.ts::envLaunchOnFirstUse)
 * pick up the opt-in unchanged.
 */
describe('P3 CLI wiring — --launch-on-first-use maps to OPENCHROME_LAUNCH_ON_FIRST_USE=1', () => {
  const ORIGINAL = process.env.OPENCHROME_LAUNCH_ON_FIRST_USE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENCHROME_LAUNCH_ON_FIRST_USE;
    else process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = ORIGINAL;
    resetLaunchGateForTests();
  });

  it('default (no flag, no env): envLaunchOnFirstUse() is false and autoLaunch passes through', () => {
    delete process.env.OPENCHROME_LAUNCH_ON_FIRST_USE;
    expect(envLaunchOnFirstUse()).toBe(false);
    // opt-in off → autoLaunch true stays true regardless of arm state.
    expect(resolveEffectiveAutoLaunch(true)).toBe(true);
  });

  it('after the CLI sets OPENCHROME_LAUNCH_ON_FIRST_USE=1, envLaunchOnFirstUse() flips to true', () => {
    // Simulate what the --launch-on-first-use CLI branch does (src/index.ts).
    process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = '1';
    expect(envLaunchOnFirstUse()).toBe(true);
  });

  it('opt-in on: autoLaunch is deferred until the gate is armed', () => {
    process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = '1';
    // Not armed yet — autoLaunch is deferred (returns false).
    expect(resolveEffectiveAutoLaunch(true)).toBe(false);
    // First tool call arms the gate — now the caller's autoLaunch takes effect.
    arm();
    expect(resolveEffectiveAutoLaunch(true)).toBe(true);
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE'])('accepts %s as on', (v) => {
    process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = v;
    expect(envLaunchOnFirstUse()).toBe(true);
  });

  it.each(['0', 'false', 'off', ''])('rejects %s as off', (v) => {
    process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = v;
    expect(envLaunchOnFirstUse()).toBe(false);
  });
});
