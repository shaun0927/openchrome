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

    expect(requestClient).toHaveBeenCalledWith('sampling/createMessage', expect.any(Object), expect.objectContaining({ timeoutMs: 5000 }));
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
});
