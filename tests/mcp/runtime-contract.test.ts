import { createRuntimeContract, validateRuntimeRequest, RUNTIME_META_KEY, PROTOCOL_META_KEY } from '../../src/mcp/runtime-contract';

describe('runtime reconnect contract', () => {
  test('keeps legacy calls and progress metadata compatible', () => {
    const runtime = createRuntimeContract();
    expect(validateRuntimeRequest(undefined, runtime)).toBeUndefined();
    expect(validateRuntimeRequest({ progressToken: 'qa' }, runtime)).toBeUndefined();
    expect(validateRuntimeRequest({ [RUNTIME_META_KEY]: runtime.runtimeId }, runtime)).toBeUndefined();
  });

  test('rejects stale handles across server generations', () => {
    const previous = createRuntimeContract();
    const current = createRuntimeContract();
    expect(previous.runtimeId).not.toBe(current.runtimeId);
    expect(validateRuntimeRequest({ [RUNTIME_META_KEY]: previous.runtimeId }, current))
      .toMatchObject({ code: -32602, data: { reason: 'STALE_RUNTIME', retrySafe: false } });
  });

  test.each([null, [], 'invalid'])('rejects malformed metadata %p', meta => {
    expect(validateRuntimeRequest(meta, createRuntimeContract())?.code).toBe(-32602);
  });

  test('does not silently execute modern requests with legacy session semantics', () => {
    expect(validateRuntimeRequest({ [PROTOCOL_META_KEY]: '2026-07-28' }, createRuntimeContract()))
      .toMatchObject({ code: -32600, data: { supported: ['2024-11-05'] } });
  });
});
