/**
 * Stealth Mode — Advanced anti-detection for enterprise bot protection bypass.
 *
 * All exports from this module are stealth-mode only and should not affect
 * normal (non-stealth) operation.
 */

export {
  humanMouseMove,
  humanType,
  humanScroll,
  humanDelay,
  simulatePresence,
} from './human-behavior';

export {
  getStealthFingerprintDefenseScript,
  getStealthStackSanitizationScript,
} from './fingerprint-defense';
