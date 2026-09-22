import {
  buildElementDecisionView,
  decisionViewHasAnswer,
  type ElementDecisionViewInput,
} from '../../../src/pilot/decider';

function target(ref: string, name: string): ElementDecisionViewInput['targets'][number] {
  return { ref, role: 'button', name, value: '', state: 'click|hover|focus' };
}

describe('element decision view builder', () => {
  it('builds numbered target choices, viewport summary, recent history, and none', () => {
    const built = buildElementDecisionView({
      id: 'element-1',
      query: 'open checkout',
      targets: [target('ref_1', 'Home'), target('ref_2', 'Checkout')],
      above: 3,
      below: 7,
      history: [
        { action: 'navigate /', result: 'ok' },
        { action: 'click catalog', result: 'ok' },
        { action: 'click item', result: 'ok' },
      ],
    }, { historyLimit: 2 });

    expect(built.question.choices).toEqual([
      { id: 'ref_1', label: '1. button "Home" [click|hover|focus]' },
      { id: 'ref_2', label: '2. button "Checkout" [click|hover|focus]' },
      { id: 'none', label: 'None of the listed targets' },
    ]);
    expect(built.state.viewport).toEqual({
      above: 3,
      below: 7,
      summary: '3 targets above viewport, 7 targets below viewport',
    });
    expect(built.state.recent_history).toEqual([
      { action: 'click catalog', result: 'ok' },
      { action: 'click item', result: 'ok' },
    ]);
    expect(built.metrics).toMatchObject({
      target_count_total: 2,
      target_count_included: 2,
      omitted_history: 1,
    });
  });

  it('keeps the view within the byte budget while preserving the none option', () => {
    const built = buildElementDecisionView({
      id: 'element-budget',
      query: 'choose the correct result',
      targets: Array.from({ length: 30 }, (_unused, index) => target(`ref_${index}`, `Very long target name ${index}`)),
      above: 12,
      below: 18,
      history: Array.from({ length: 10 }, (_unused, index) => ({ action: `action ${index}`, result: `result ${index}` })),
    }, { maxBytes: 900, maxTargets: 30, historyLimit: 10 });

    expect(built.metrics.byte_length).toBeLessThanOrEqual(900);
    expect(built.metrics.omitted_targets).toBeGreaterThan(0);
    expect(built.metrics.omitted_history).toBeGreaterThan(0);
    expect(decisionViewHasAnswer(built.question, 'none')).toBe(true);
  });

  it('reports whether a labeled answer survived truncation', () => {
    const built = buildElementDecisionView({
      id: 'element-answer',
      query: 'choose late target',
      targets: [target('ref_1', 'First'), target('ref_2', 'Second'), target('ref_3', 'Third')],
      above: 0,
      below: 0,
      history: [],
    }, { maxTargets: 2 });

    expect(decisionViewHasAnswer(built.question, 'ref_2')).toBe(true);
    expect(decisionViewHasAnswer(built.question, 'ref_3')).toBe(false);
  });
});
