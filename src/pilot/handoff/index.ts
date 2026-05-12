/**
 * Pilot Handoff — barrel export (Phase 3, issue #793).
 *
 * Surface mirrors the closed reference PR #754 design, slimmed to the
 * pilot-tier slice the issue requested: token + banner + in-memory
 * manager + MCP tool. Persistence (#794) layers on top of this without
 * changing the public API.
 *
 * Import-safety: this module re-exports siblings only; no work happens
 * at module load. The pilot bootstrap (`src/pilot/index.ts`) may import
 * this barrel unconditionally without bringing eager side effects.
 */

export {
  createHandoffToken,
  verifyHandoffToken,
  DEFAULT_TOKEN_TTL_MS,
  HANDOFF_TOKEN_BYTES,
  HANDOFF_TOKEN_LENGTH,
} from './token.js';
export type { CreateHandoffTokenArgs, HandoffTokenResult } from './token.js';

export { renderHandoffBanner } from './banner.js';
export type { HandoffBannerPayload } from './banner.js';

export { HandoffManager } from './manager.js';
export type {
  HandoffManagerOptions,
  HandoffPayload,
  HandoffRecord,
  HandoffRedemption,
} from './manager.js';

export { registerOcPilotHandoffTool } from './tool.js';
