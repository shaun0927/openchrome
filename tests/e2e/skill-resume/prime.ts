import * as fs from 'node:fs';
import * as path from 'node:path';

import { SkillGraphStorage } from '../../../src/core/skill/storage';
import type { ExecutorAction } from '../../../src/pilot/skill/types';

export interface SkillResumePrimeStep {
  fromState: string;
  action: ExecutorAction;
  toState: string;
  successCount?: number;
}

export interface SkillResumePrimeInput {
  rootDir: string;
  domain: string;
  initialState: string;
  targetState: string;
  steps?: SkillResumePrimeStep[];
}

export interface SkillResumePrimeResult {
  rootDir: string;
  domain: string;
  graphPath: string;
  nodeCount: number;
  edgeCount: number;
}

export const CART_FIXTURE_STATES = {
  cartPopulated: 'state-cart-populated',
  targetAdded: 'state-target-added',
} as const;

export const CART_FIXTURE_ACTIONS = {
  addTargetItem: {
    kind: 'click',
    argsNorm: 'button[data-testid="add-target"]',
  },
} as const satisfies Record<string, ExecutorAction>;

/**
 * Seed a deterministic skill graph for the #717 skill-resume e2e.
 *
 * The utility writes through SkillGraphStorage rather than hand-writing JSON so
 * future storage migrations are caught by this fixture before the real-Chrome
 * spec depends on it.
 */
export async function primeSkillResumeGraph(input: SkillResumePrimeInput): Promise<SkillResumePrimeResult> {
  fs.mkdirSync(input.rootDir, { recursive: true });
  const storage = new SkillGraphStorage({ rootDir: input.rootDir, domain: input.domain });
  const steps = input.steps ?? [{
    fromState: input.initialState,
    action: CART_FIXTURE_ACTIONS.addTargetItem,
    toState: input.targetState,
    successCount: 3,
  }];

  for (const step of steps) {
    const count = Math.max(1, Math.floor(step.successCount ?? 1));
    for (let i = 0; i < count; i++) {
      await storage.recordSuccess({
        fromState: step.fromState,
        actionKind: step.action.kind,
        actionArgsNorm: step.action.argsNorm,
      }, step.toState);
    }
  }

  const summary = storage.inspect();
  return {
    rootDir: input.rootDir,
    domain: input.domain,
    graphPath: path.resolve(storage.getFilePath()),
    nodeCount: summary.nodeCount,
    edgeCount: summary.edgeCount,
  };
}
