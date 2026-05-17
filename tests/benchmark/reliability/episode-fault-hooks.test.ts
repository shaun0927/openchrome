/// <reference types="jest" />
import { beforeEpisodeStep, finalizeFaultRecovery } from './episode-fault-hooks';

describe('episode fault hooks', () => {
  test('injects a planned fault at the configured step and marks recovery by final postcondition', async () => {
    const state = { events: [], recovered: null };
    const plan = { taskId: 'rw', injectAtStep: 2, fault: 'selector-drift' as const, expectedRecoverySignal: 'semantic retry' };
    const executor = { inject: jest.fn(async () => 'selector changed') };
    await beforeEpisodeStep(1, plan, executor, state);
    await beforeEpisodeStep(2, plan, executor, state);
    expect(executor.inject).toHaveBeenCalledTimes(1);
    expect(state.events[0].fault).toBe('selector-drift');
    expect(finalizeFaultRecovery(state, true).recovered).toBe(true);
    expect(finalizeFaultRecovery(state, false).recovered).toBe(false);
  });
});
