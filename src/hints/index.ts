/**
 * Hints module — Proactive hint system
 */

export { HintEngine } from './hint-engine';
export type { HintContext, HintRule, HintLogEntry, HintSeverity, HintResult } from './hint-engine';
export { PatternLearner } from './pattern-learner';
export type { LearnedPattern } from './pattern-learner';
export {
  PatternLearnerEventBus,
  buildAddEvent,
  buildUpdateEvent,
  buildDeleteEvent,
  buildNoopEvent,
  diffPatterns,
} from './pattern-learner-events';
export type {
  PatternLearnerEvent,
  PatternLearnerEventKind,
  PatternLearnerEventListener,
  PatternLearnerChangeSet,
  PatternLearnerNoopReason,
} from './pattern-learner-events';
