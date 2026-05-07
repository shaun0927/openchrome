/**
 * Multi-model voting subsystem barrel (#711). Provider HTTP wrappers
 * (anthropic / openai) ride a follow-up — they're plain `fetch` calls
 * that conform to the `VotingProvider` interface and don't change the
 * orchestrator API.
 */

export {
  COORDINATE_TOLERANCE_PX,
  SCROLL_TOLERANCE_PX,
  actionsEquivalent,
  type ActionInvocation,
  type EquivalenceContext,
} from './args-equivalence';

export {
  VotingOrchestrator,
  VotingSessionBudget,
  extractFirstJsonObject,
  type ProviderError,
  type ProviderErrorKind,
  type ProviderReply,
  type VoteRequest,
  type VoteVerdict,
  type VotingDisagreement,
  type VotingOrchestratorOptions,
  type VotingPolicy,
  type VotingProvider,
} from './orchestrator';
