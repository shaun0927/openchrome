/**
 * Handoff subsystem barrel — token + banner + manager + persistence.
 * OS-keychain bridges (macOS Keychain, Windows Credential Manager) ride
 * a separate follow-up; the PersistenceAdapter interface is the
 * extension point.
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

export {
  EncryptedFilePersistence,
  NoopPersistence,
  PlaintextFilePersistence,
  _resetAutoSelectWarning,
  autoSelectHandoffPersistence,
  defaultHandoffRootDir,
  type EncryptedFilePersistenceOptions,
  type FilePersistenceOptions,
  type PersistenceAdapter,
} from './persistence';
