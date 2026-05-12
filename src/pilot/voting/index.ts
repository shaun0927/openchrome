/**
 * Multi-model voting subsystem barrel (Phase 4, replaces #759).
 *
 * The voting framework is voter-agnostic: a `Voter` can be a
 * deterministic implementation (always-proceed, structural-match, etc.)
 * or an LLM-backed implementation. LLM-backed voter HTTP wrappers
 * (Anthropic, OpenAI) ship in the separate `openchrome-perception-voters`
 * package (#775) and conform to the `Voter` interface exported here.
 *
 * Gated by `isPerceptionVotingEnabled()` from `src/harness/flags.ts`.
 */

export {
  COORDINATE_TOLERANCE_PX,
  SCROLL_TOLERANCE_PX,
  actionsEquivalent,
  type ActionInvocation,
  type EquivalenceContext,
} from './args-equivalence.js';

export {
  VotingOrchestrator,
  VotingSessionBudget,
  extractFirstJsonObject,
  vote,
  type VoterError,
  type VoterErrorKind,
  type VoterReply,
  type VoteRequest,
  type VoteVerdict,
  type VotingDisagreement,
  type VotingOrchestratorOptions,
  type VotingPolicy,
  type Voter,
  type VotingProvider,
} from './orchestrator.js';
