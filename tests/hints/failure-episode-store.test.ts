import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FailureEpisodeStore } from '../../src/hints/failure-episode-store';

describe('FailureEpisodeStore', () => {
  it('persists verified recovery episodes with redacted bounded summaries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-episodes-'));
    const filePath = path.join(dir, 'failure-episodes.json');
    const store = new FailureEpisodeStore({ filePath, now: () => 1000 });

    store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'element not interactive password=hunter2 user@example.com',
      recoveryTool: 'read_page',
      failure: {
        domain: 'https://example.test/form',
        taskIntent: 'submit contact form token=abc123',
        stateFingerprint: 'overlay-present',
        actionSummary: 'click submit',
      },
      recovery: {
        actionSummary: 'dismiss overlay then retry',
        evidenceSummary: 'success banner visible api_key=secret123',
      },
    });

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('example.test');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('user@example.com');
    expect(raw).not.toContain('secret123');
  });

  it('normalizes failed tool names before matching episodes', () => {
    const store = new FailureEpisodeStore({ now: () => 1000 });
    const episode = store.recordVerifiedRecovery({
      failedTool: 'Interact Tool',
      errorFingerprint: 'element not interactive',
      recoveryTool: 'Read Page',
      failure: { domain: 'example.test' },
      recovery: { actionSummary: 'inspect page' },
    });

    expect(store.match({
      failedTool: 'interact_tool',
      errorFingerprint: 'element not interactive',
      domain: 'example.test',
    })?.id).toBe(episode.id);
    expect(episode.failed_tool).toBe('interact_tool');
    expect(episode.recovery_tools).toEqual(['read_page']);
  });

  it('matches by domain, tool, error, task/state context and builds advisory hints', () => {
    const store = new FailureEpisodeStore({ now: () => 1000 });
    const episode = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'element not interactive',
      recoveryTool: 'read_page',
      failure: { domain: 'example.test', taskIntent: 'submit form', stateFingerprint: 'overlay-present' },
      recovery: { actionSummary: 'inspect page and dismiss overlay' },
    });

    const match = store.match({
      failedTool: 'interact',
      errorFingerprint: 'element not interactive on button',
      domain: 'example.test',
      taskIntent: 'submit contact form',
      stateFingerprint: 'overlay-present',
    });

    expect(match?.id).toBe(episode.id);
    const hint = store.buildHint(match!);
    expect(hint).toContain('Suggested recovery');
    expect(hint).toContain('no recovery was auto-executed');
  });

  it('prunes low-confidence and over-cap stale/noisy episodes', () => {
    let now = 1000;
    const store = new FailureEpisodeStore({ now: () => now, maxEpisodes: 1, staleAfterMs: 50 });
    const first = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'first failure',
      recoveryTool: 'read_page',
    });
    now += 10;
    const second = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'second failure',
      recoveryTool: 'find',
    });

    expect(store.list().map((episode) => episode.id)).toEqual([second.id]);
    store.recordFailedReuse(second.id);
    store.recordFailedReuse(second.id);
    expect(store.list()).toHaveLength(0);

    now += 100;
    store.recordFailedReuse(first.id);
    expect(store.match({ failedTool: 'interact', errorFingerprint: 'first failure' })).toBeNull();
  });

  it('includes error fingerprint in generated episode ids', () => {
    const store = new FailureEpisodeStore({ now: () => 1000 });

    const timeout = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'timeout waiting for element',
      recoveryTool: 'read_page',
      failure: { domain: 'example.test' },
    });
    const staleRef = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'stale ref for element',
      recoveryTool: 'read_page',
      failure: { domain: 'example.test' },
    });

    expect(timeout.id).not.toBe(staleRef.id);
    expect(timeout.id).toMatch(/timeout-waiting-fo-[0-9a-f]{8}$/);
    expect(staleRef.id).toMatch(/stale-ref-for-elem-[0-9a-f]{8}$/);
  });


  it('uses a hash suffix so truncated slugs remain collision-resistant', () => {
    const store = new FailureEpisodeStore({ now: () => 2000 });
    const first = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'alpha beta gamma delta epsilon '.repeat(6) + 'first unique tail',
      recoveryTool: 'read_page',
      failure: { domain: 'example.test' },
    });
    const second = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'zulu yankee xray whiskey victor '.repeat(6) + 'second unique tail',
      recoveryTool: 'read_page',
      failure: { domain: 'example.test' },
    });

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/-[0-9a-f]{8}$/);
    expect(second.id).toMatch(/-[0-9a-f]{8}$/);
  });


  it('does not infer domains from non-URL task text', () => {
    const store = new FailureEpisodeStore({ now: () => 3000 });
    const episode = store.recordVerifiedRecovery({
      failedTool: 'interact',
      errorFingerprint: 'button missing',
      recoveryTool: 'read_page',
      failure: { domain: 'checkout flow step' },
    });

    expect(episode.domain).toBe('unknown');
  });

});
