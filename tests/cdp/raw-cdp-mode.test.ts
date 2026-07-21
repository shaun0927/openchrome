import { describe, expect, it } from '@jest/globals';
import {
  createRawCdpMode,
  withRawCdpAudit,
  type RawCdpDecision,
} from '../../src/cdp/raw-cdp-mode.js';

describe('createRawCdpMode', () => {
  it('off level permits everything', () => {
    const mode = createRawCdpMode({ level: 'off' });
    expect(mode.allow('Runtime.enable')).toBe(true);
    expect(mode.allow('Log.entryAdded')).toBe(true);
  });

  it('lean level drops passive leak listeners', () => {
    const mode = createRawCdpMode({ level: 'lean' });
    expect(mode.allow('Runtime.consoleAPICalled')).toBe(false);
    expect(mode.allow('Runtime.enable')).toBe(true);
  });

  it('strict level guards enables unless user-action', () => {
    const mode = createRawCdpMode({ level: 'strict' });
    expect(mode.allow('Runtime.enable', { source: 'auto-attach' })).toBe(false);
    expect(mode.allow('Runtime.enable', { source: 'user-action' })).toBe(true);
    expect(mode.allow('Page.getFrameTree', { source: 'action' })).toBe(true);
  });

  it('honours extraBlocklist and allowlist', () => {
    const mode = createRawCdpMode({
      level: 'lean',
      extraBlocklist: ['Network.enable'],
      allowlist: ['Runtime.consoleAPICalled'],
    });
    expect(mode.allow('Network.enable')).toBe(false);
    expect(mode.allow('Runtime.consoleAPICalled')).toBe(true);
  });

  it('explain returns a stable reason string', () => {
    const mode = createRawCdpMode({ level: 'strict' });
    const decision = mode.explain('Runtime.enable', { source: 'auto-attach' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('strict:guarded-enable');
  });
});

describe('withRawCdpAudit', () => {
  it('notifies only on blocks', () => {
    const base = createRawCdpMode({ level: 'strict' });
    const blocks: Array<[string, RawCdpDecision]> = [];
    const audited = withRawCdpAudit(base, (m, d) => blocks.push([m, d]));
    audited.allow('Page.getFrameTree', { source: 'action' }); // allowed
    audited.allow('Runtime.enable', { source: 'auto-attach' }); // blocked
    expect(blocks).toHaveLength(1);
    expect(blocks[0]![0]).toBe('Runtime.enable');
  });
});
