import type { EpisodeFaultPlan, FaultEvent } from './fault-plan';
import { validateFaultPlan } from './fault-plan';

export interface FaultExecutor { inject(plan: EpisodeFaultPlan): Promise<string>; }
export interface FaultHookState { events: FaultEvent[]; recovered: boolean | null; }

export async function beforeEpisodeStep(step: number, plan: EpisodeFaultPlan | undefined, executor: FaultExecutor, state: FaultHookState): Promise<void> {
  if (!plan || step !== plan.injectAtStep) return;
  if (state.events.some((event) => event.step === step && event.fault === plan.fault && event.injected)) return;
  validateFaultPlan(plan);
  const evidence = await executor.inject(plan);
  state.events.push({ step, fault: plan.fault, injected: true, evidence });
}

export function finalizeFaultRecovery(state: FaultHookState, finalPostconditionPassed: boolean): FaultHookState {
  return { ...state, recovered: state.events.length === 0 ? null : finalPostconditionPassed };
}
