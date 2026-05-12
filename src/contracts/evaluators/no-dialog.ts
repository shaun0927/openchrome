import type { EvalContext } from '../eval-context';
import type { EvaluationResult, NoDialogAssertion } from '../types';

export async function evaluateNoDialog(
  _assertion: NoDialogAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  const open = await ctx.hasOpenDialog();
  const passed = !open;
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'no_dialog',
      details: { dialog_open: open },
    },
  };
}
