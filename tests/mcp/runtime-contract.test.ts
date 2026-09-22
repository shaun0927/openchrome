import { createRuntimeContract, validateRuntimeRequest, rejectUnsupportedProtocol, RUNTIME_META_KEY, PROTOCOL_META_KEY } from '../../src/mcp/runtime-contract';

describe('runtime reconnect contract', () => {
  test.each(['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'])('rejects unadvertised HTTP version %s', version => {
    expect(rejectUnsupportedProtocol(undefined, version)?.code).toBe(-32600);
  });

  test('accepts only the advertised HTTP version or an absent legacy header', () => {
    expect(rejectUnsupportedProtocol(undefined, '2024-11-05')).toBeUndefined();
    expect(rejectUnsupportedProtocol(undefined)).toBeUndefined();
  });
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
