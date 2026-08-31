import {
  SessionManager,
  getSessionManager as getSessionManagerImpl,
  _resetSessionManagerForTesting as resetSessionManagerForTestingImpl,
} from './session/manager';

export {
  SessionManager,
  type SessionManagerConfig,
  type SessionManagerStats,
  type ExternalTargetRegistrationOptions,
  type PopupTargetRegistrationOptions,
} from './session/manager';

export function getSessionManager(): SessionManager {
  return getSessionManagerImpl();
}

export function _resetSessionManagerForTesting(): void {
  resetSessionManagerForTestingImpl();
}
