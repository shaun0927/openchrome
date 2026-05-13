/**
 * Trace-target redactor allow-list test (#844).
 *
 * The three keys introduced by the backend-node uid contract under
 * `args.target` (`nodeRef`, `backendNodeId`, `loaderId`) are non-sensitive.
 * This test pins the contract: they survive `redactValue` unchanged so a
 * future tightening of `SENSITIVE_KEY_NAMES` does not silently start
 * redacting them.
 */

import { redactValue, TRACE_TARGET_ALLOWLIST } from '../../../src/core/trace/redactor';
import { makeTraceTarget, type TraceTarget } from '../../../src/core/trace/types';

describe('trace redactor — TraceTarget allow-list (#844)', () => {
  test('exports the documented allow-list', () => {
    expect(TRACE_TARGET_ALLOWLIST).toEqual(['nodeRef', 'backendNodeId', 'loaderId']);
  });

  test('passes through every allow-listed key unchanged', () => {
    const target: TraceTarget = makeTraceTarget('n_42', 142857, 'loader-XYZ');
    const wrapper = { args: { target } };
    const redacted = redactValue(wrapper) as { args: { target: TraceTarget } };
    expect(redacted.args.target.nodeRef).toBe('n_42');
    expect(redacted.args.target.backendNodeId).toBe(142857);
    expect(redacted.args.target.loaderId).toBe('loader-XYZ');
  });

  test('passes through nodeRef=null (flag-off branch) unchanged', () => {
    const target: TraceTarget = makeTraceTarget(null, 1, 'loader-A');
    const redacted = redactValue({ args: { target } }) as {
      args: { target: TraceTarget };
    };
    expect(redacted.args.target.nodeRef).toBeNull();
    expect(redacted.args.target.backendNodeId).toBe(1);
    expect(redacted.args.target.loaderId).toBe('loader-A');
  });

  test('does not interfere with redacting genuinely sensitive siblings', () => {
    const target: TraceTarget = makeTraceTarget('n_1', 1, 'loader-A');
    const event = {
      args: {
        target,
        password: 'hunter2',
        token: 'eyJabcdef.eyJghijkl.signaturesignature',
      },
    };
    const redacted = redactValue(event) as {
      args: { target: TraceTarget; password: string; token: string };
    };
    expect(redacted.args.target.nodeRef).toBe('n_1');
    expect(redacted.args.password).toBe('[REDACTED]');
    expect(redacted.args.token).toBe('[REDACTED]');
  });

  test('makeTraceTarget validates input shape', () => {
    expect(() => makeTraceTarget('', 1, 'l')).toThrow();
    expect(() => makeTraceTarget('n_1', 0, 'l')).toThrow();
    expect(() => makeTraceTarget('n_1', 1, '')).toThrow();
  });
});
