import { describe, expect, it } from '@jest/globals';
import { assertHostAllowed, envAllowRemote } from '../../src/cdp/host-guard';

/**
 * Wiring test for the P2 pack CLI surface. Codex flagged that the promised
 * `--allow-remote` flag was absent — only the env var
 * OPENCHROME_ALLOW_REMOTE_CDP existed. This test pins the wiring the CLI
 * uses: when `--allow-remote` is present, the CLI sets
 * OPENCHROME_ALLOW_REMOTE_CDP=1 so downstream host-guard consumers pick it
 * up unchanged.
 *
 * We assert the env-var contract itself (envAllowRemote + assertHostAllowed),
 * not commander parsing — the CLI mapping is one line in src/index.ts and
 * belongs to an integration test surface; the wiring guarantee is that the
 * env var, once set, actually flips the host-guard decision.
 */
describe('P2 CLI wiring — --allow-remote maps to OPENCHROME_ALLOW_REMOTE_CDP=1', () => {
  const ORIGINAL = process.env.OPENCHROME_ALLOW_REMOTE_CDP;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENCHROME_ALLOW_REMOTE_CDP;
    else process.env.OPENCHROME_ALLOW_REMOTE_CDP = ORIGINAL;
  });

  it('a non-loopback endpoint is refused by default (no flag, no env)', () => {
    delete process.env.OPENCHROME_ALLOW_REMOTE_CDP;
    expect(envAllowRemote()).toBe(false);
    expect(() =>
      assertHostAllowed('ws://10.0.0.5:9222/devtools/browser/abc'),
    ).toThrow(/refused non-localhost/i);
  });

  it('after the CLI sets OPENCHROME_ALLOW_REMOTE_CDP=1, the same endpoint is accepted', () => {
    // Simulate what the --allow-remote CLI branch does (src/index.ts).
    process.env.OPENCHROME_ALLOW_REMOTE_CDP = '1';
    expect(envAllowRemote()).toBe(true);
    expect(() =>
      assertHostAllowed('ws://10.0.0.5:9222/devtools/browser/abc'),
    ).not.toThrow();
  });

  it('opts.allowRemote=true remains an equivalent programmatic path', () => {
    delete process.env.OPENCHROME_ALLOW_REMOTE_CDP;
    expect(() =>
      assertHostAllowed('ws://10.0.0.5:9222/devtools/browser/abc', {
        allowRemote: true,
      }),
    ).not.toThrow();
  });
});
