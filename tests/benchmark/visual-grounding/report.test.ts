import { evaluateVisualGroundingReport } from './report';
import { runMockVisualGroundingBenchmark } from './mock-runner';

it('produces a passing visual grounding benchmark report for all required scenarios', () => {
  const report = runMockVisualGroundingBenchmark();

  expect(report.summary).toEqual({ pass: true, failures: [] });
  expect(report.scenarios.map((scenario) => scenario.name)).toEqual([
    'dom-ax-normal',
    'poor-label-visual',
    'canvas-visual-only',
    'ambiguous-visual',
    'unsafe-visual-target',
    'provider-timeout',
    'long-running-soak',
  ]);
  expect(report.scenarios.every((scenario) => scenario.wrongClicks === 0)).toBe(true);
});

it('fails reports that miss visual-only grounding, ambiguity blocking, or memory bounds', () => {
  const report = runMockVisualGroundingBenchmark();
  const broken = evaluateVisualGroundingReport({
    ...report,
    scenarios: report.scenarios.map((scenario) => {
      if (scenario.name === 'canvas-visual-only') return { ...scenario, strategyUsed: 'S1_AX' };
      if (scenario.name === 'ambiguous-visual') return { ...scenario, strategyUsed: 'S7_VISUAL_GROUNDING', wrongClicks: 1 };
      if (scenario.name === 'long-running-soak') return { ...scenario, health: { memoryGrowthMb: 99 } };
      return scenario;
    }),
  });

  expect(broken.summary.pass).toBe(false);
  expect(broken.summary.failures).toEqual(expect.arrayContaining([
    'canvas-visual-only: expected S7_VISUAL_GROUNDING',
    'ambiguous-visual: wrongClicks=1',
    'ambiguous-visual: expected HITL/blocked/rejected strategy',
    'long-running-soak: memoryGrowthMb=99',
  ]));
});
