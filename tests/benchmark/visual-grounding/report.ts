import { REQUIRED_VISUAL_GROUNDING_SCENARIOS, VisualGroundingReport } from './types';

export function evaluateVisualGroundingReport(report: VisualGroundingReport): VisualGroundingReport {
  const failures: string[] = [];
  const byName = new Map(report.scenarios.map((scenario) => [scenario.name, scenario]));

  for (const name of REQUIRED_VISUAL_GROUNDING_SCENARIOS) {
    if (!byName.has(name)) failures.push(`missing scenario: ${name}`);
  }
  for (const scenario of report.scenarios) {
    if (!scenario.success) failures.push(`${scenario.name}: scenario failed`);
    if (scenario.wrongClicks !== 0) failures.push(`${scenario.name}: wrongClicks=${scenario.wrongClicks}`);
    if (scenario.toolCalls <= 0) failures.push(`${scenario.name}: toolCalls must be positive`);
    if (scenario.latencyMs < 0) failures.push(`${scenario.name}: latencyMs must be non-negative`);
  }

  const canvas = byName.get('canvas-visual-only');
  if (canvas && canvas.strategyUsed !== 'S7_VISUAL_GROUNDING') {
    failures.push('canvas-visual-only: expected S7_VISUAL_GROUNDING');
  }
  const ambiguous = byName.get('ambiguous-visual');
  if (ambiguous && !/(HITL|blocked|rejected)/i.test(ambiguous.strategyUsed)) {
    failures.push('ambiguous-visual: expected HITL/blocked/rejected strategy');
  }
  const unsafe = byName.get('unsafe-visual-target');
  if (unsafe && !/(HITL|blocked|rejected)/i.test(unsafe.strategyUsed)) {
    failures.push('unsafe-visual-target: expected blocked strategy');
  }
  const timeout = byName.get('provider-timeout');
  if (timeout && !/(fallback|dom)/i.test(timeout.provider)) {
    failures.push('provider-timeout: expected fallback/dom provider');
  }
  const soak = byName.get('long-running-soak');
  if (soak?.health && soak.health.memoryGrowthMb > 75) {
    failures.push(`long-running-soak: memoryGrowthMb=${soak.health.memoryGrowthMb}`);
  }

  return { ...report, summary: { pass: failures.length === 0, failures } };
}
