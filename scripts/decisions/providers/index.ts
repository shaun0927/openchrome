/**
 * Provider registry for scripts/eval-decisions.ts.
 */

import { createFileProvider } from './file';
import { createNoopProvider } from './noop';
import { createRegexProvider } from './regex';
import { createTypeSafeProvider } from './typesafe';
import type { DecisionProvider, ProviderOptions } from './types';

export type { DecisionProvider, ProviderAnswer, ProviderInit, ProviderOptions } from './types';

export const PROVIDER_NAMES = ['noop', 'regex', 'file', 'typesafe'] as const;
export type ProviderName = typeof PROVIDER_NAMES[number];

export function createProvider(name: string, opts: ProviderOptions = {}): DecisionProvider {
  switch (name) {
    case 'noop': return createNoopProvider();
    case 'regex': return createRegexProvider();
    case 'file': return createFileProvider(opts.answersFile);
    case 'typesafe': return createTypeSafeProvider(opts);
    default: throw new Error(`unknown provider "${name}" (known: ${PROVIDER_NAMES.join(', ')})`);
  }
}
