import { OutboundDecisionBudget, createHostDecisionProvider, createNoopDecisionProvider, decideWithBudget } from '../../../src/pilot/decider';

test('invalid budget values cannot bypass the request limit', () => {
  for (const value of [NaN, Infinity, -1, 0.5]) {
    expect(() => new OutboundDecisionBudget(value)).toThrow(RangeError);
    expect(() => new OutboundDecisionBudget(1).tryCharge(value)).toThrow(RangeError);
  }
});

test.each(['invalid', 'throw'])('runner downgrades %s primary responses', async (mode) => {
  const primary = createHostDecisionProvider(async () => {
    if (mode === 'throw') throw new Error('unavailable');
    return { answer: 'unlisted', confidence: 1, abstain: false };
  });
  const result = await decideWithBudget({ id: 'test', instructions: '', state: {}, choices: [{ id: 'allowed', label: 'Allowed' }] }, {
    primary, fallback: createNoopDecisionProvider(), budget: new OutboundDecisionBudget(1),
  });
  expect(result).toMatchObject({ answer: 'none', abstain: true, downgraded: true });
});
