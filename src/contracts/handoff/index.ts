/**
 * Handoff subsystem barrel — token + banner + manager. Persistence and
 * keychain integration land in PR-15.
 */

export {
  HANDOFF_TOKEN_HEX_LENGTH,
  generateHandoffToken,
  verifyHandoffToken,
} from './token';

export { bannerTagName, buildBannerScript, type BannerSpec } from './banner';

export {
  HandoffManager,
  type HandoffEscalationReason,
  type HandoffStatus,
  type HandoffRecord,
  type CreateHandoffArgs,
  type HandoffManagerOptions,
  type ResumeResult,
} from './manager';
