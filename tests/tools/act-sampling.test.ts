import { __test__ } from '../../src/tools/act';

describe('act client-mediated sampling (#876)', () => {
  const parsedActions = [
    { action: 'click' as const, target: 'Sign in' },
    { action: 'type' as const, target: 'Email', value: 'a@example.test' },
  ];

  test('falls back deterministically when sampling is unavailable', async () => {
    const result = await __test__.maybeRefineActionsWithSampling('sign in', parsedActions, {} as any);
    expect(result.actions).toBe(parsedActions);
    expect(result.decision).toMatchObject({ supported: false, used: false, fallbackReason: 'sampling_unavailable' });
  });

  test('accepts strict JSON sampled actions from the MCP client', async () => {
    const requestClient = jest.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ actions: [{ action: 'click', target: 'Continue' }] }) }],
    }));

    const result = await __test__.maybeRefineActionsWithSampling('continue', parsedActions, {
      clientCapabilities: { sampling: {} },
      requestClient,
    } as any);

    expect(requestClient).toHaveBeenCalledWith('sampling/createMessage', expect.any(Object), expect.objectContaining({ timeoutMs: 8000 }));
    expect(result.actions).toEqual([{ action: 'click', target: 'Continue' }]);
    expect(result.decision).toMatchObject({ supported: true, used: true });
  });

  test('rejects malformed sampling output and keeps parsed actions', async () => {
    const requestClient = jest.fn(async () => ({ content: [{ type: 'text', text: '{not-json' }] }));
    const result = await __test__.maybeRefineActionsWithSampling('continue', parsedActions, {
      clientCapabilities: { sampling: {} },
      requestClient,
    } as any);

    expect(result.actions).toBe(parsedActions);
    expect(result.decision).toMatchObject({ used: false, fallbackReason: 'invalid_sampling_response' });
  });

  test('maps sampling timeout errors to the closed-set "timeout" fallback reason', async () => {
    const requestClient = jest.fn(async () => { throw new Error('s2c_timeout:sampling/createMessage'); });
    const result = await __test__.maybeRefineActionsWithSampling('continue', parsedActions, {
      clientCapabilities: { sampling: {} },
      requestClient,
    } as any);

    expect(result.actions).toBe(parsedActions);
    expect(result.decision).toMatchObject({ supported: true, used: false, fallbackReason: 'timeout' });
  });

  test('maps host-side cancellation to the closed-set "cancelled" fallback reason', async () => {
    const requestClient = jest.fn(async () => { throw new Error('AbortError: cancelled by host'); });
    const result = await __test__.maybeRefineActionsWithSampling('continue', parsedActions, {
      clientCapabilities: { sampling: {} },
      requestClient,
    } as any);

    expect(result.actions).toBe(parsedActions);
    expect(result.decision).toMatchObject({ used: false, fallbackReason: 'cancelled' });
  });

  test('falls back to the closed-set "transport_error" reason on opaque transport failures', async () => {
    const requestClient = jest.fn(async () => { throw new Error('connection reset'); });
    const result = await __test__.maybeRefineActionsWithSampling('continue', parsedActions, {
      clientCapabilities: { sampling: {} },
      requestClient,
    } as any);

    expect(result.actions).toBe(parsedActions);
    expect(result.decision).toMatchObject({ used: false, fallbackReason: 'transport_error' });
  });

  test('treats url as a fallback for value but does not let url shadow value', () => {
    const parsed = __test__.parseSampledActions({
      content: [{ type: 'text', text: JSON.stringify({ actions: [
        { action: 'navigate', value: 'https://wins.test', url: 'https://loses.test' },
        { action: 'navigate', url: 'https://only-url.test' },
      ] }) }],
    });

    expect(parsed).toEqual([
      { action: 'navigate', value: 'https://wins.test' },
      { action: 'navigate', value: 'https://only-url.test' },
    ]);
  });

  test('preserves wait condition from sampled actions', () => {
    const parsed = __test__.parseSampledActions({
      content: [{ type: 'text', text: JSON.stringify({ actions: [
        { action: 'wait', target: 'Submit', condition: 'appear' },
      ] }) }],
    });

    expect(parsed).toEqual([{ action: 'wait', target: 'Submit', condition: 'appear' }]);
  });
});
