/**
 * `noop` provider — always abstains with confidence 0.
 *
 * This is the floor every other provider is measured against: a provider
 * that cannot beat `noop` on the intact corpus carries no information.
 */

import type { DecisionProvider, ProviderAnswer } from './types';
import { abstain } from './types';

export function createNoopProvider(): DecisionProvider {
  return {
    name: 'noop',
    async decide(): Promise<ProviderAnswer> {
      return abstain();
    },
  };
}
