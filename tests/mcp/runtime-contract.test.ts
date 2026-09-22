import {
  createRuntimeContract,
  validateRuntimeRequest,
  rejectUnsupportedLegacyHttpVersion,
  RUNTIME_META_KEY,
  PROTOCOL_META_KEY,
  MODERN_PROTOCOL_VERSION,
} from '../../src/mcp/runtime-contract';

describe('runtime reconnect contract', () => {
  test.each(['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'])(
    'rejects %s on the sessionful legacy HTTP path',
    version => {
      expect(rejectUnsupportedLegacyHttpVersion(version)).toMatchObject({
        code: -32600,
        data: { requested: version, supported: ['2024-11-05', '2026-07-28'] },
      });
    },
  );

  test('accepts the negotiated legacy HTTP version or an absent header', () => {
    expect(rejectUnsupportedLegacyHttpVersion('2024-11-05')).toBeUndefined();
    expect(rejectUnsupportedLegacyHttpVersion(undefined)).toBeUndefined();
  });

  test('advertises dual-era support per transport', () => {
    const runtime = createRuntimeContract();
    expect(runtime.protocolMode).toBe('dual-era');
    expect(runtime.protocolSupport.http.legacy).toEqual(['2024-11-05']);
    expect(runtime.protocolSupport.http.modern).toEqual([MODERN_PROTOCOL_VERSION]);
    expect(runtime.protocolSupport.stdio.modern).toEqual([MODERN_PROTOCOL_VERSION]);
    expect(runtime.protocolSupport.stdio.legacy).toEqual(expect.arrayContaining(['2024-11-05', '2025-11-25']));
    expect(runtime.protocolVersions).toEqual(expect.arrayContaining(['2024-11-05', '2025-11-25', '2026-07-28']));
  });

  test('keeps legacy calls and progress metadata compatible', () => {
    const runtime = createRuntimeContract();
    expect(validateRuntimeRequest(undefined, runtime)).toBeUndefined();
    expect(validateRuntimeRequest({ progressToken: 'qa' }, runtime)).toBeUndefined();
    expect(validateRuntimeRequest({ [RUNTIME_META_KEY]: runtime.runtimeId }, runtime)).toBeUndefined();
  });

  test('accepts modern envelope metadata once the SDK boundary selected the era', () => {
    expect(validateRuntimeRequest({ [PROTOCOL_META_KEY]: MODERN_PROTOCOL_VERSION }, createRuntimeContract()))
      .toBeUndefined();
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
});
