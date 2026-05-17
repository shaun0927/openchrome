export type EpisodeFaultType = 'selector-drift' | 'network-stall' | 'target-closed' | 'delayed-dom' | 'cdp-disconnect';
export interface EpisodeFaultPlan { taskId: string; injectAtStep: number; fault: EpisodeFaultType; expectedRecoverySignal: string; }
export interface FaultEvent { step: number; fault: EpisodeFaultType; injected: boolean; evidence: string; }
const SUPPORTED_FAULTS = new Set<EpisodeFaultType>(['selector-drift', 'network-stall', 'target-closed', 'delayed-dom', 'cdp-disconnect']);
export function validateFaultPlan(plan: EpisodeFaultPlan): void {
  if (!plan.taskId) throw new Error('fault plan taskId is required');
  if (!Number.isInteger(plan.injectAtStep) || plan.injectAtStep < 0) throw new Error('fault plan injectAtStep must be a non-negative integer');
  if (!SUPPORTED_FAULTS.has(plan.fault)) throw new Error(`fault plan fault is unsupported: ${String(plan.fault)}`);
  if (!plan.expectedRecoverySignal) throw new Error('fault plan expectedRecoverySignal is required');
}
