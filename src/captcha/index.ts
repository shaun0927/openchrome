/**
 * CAPTCHA module - detection, classification, and solving (#574)
 */

export { detectCaptcha } from './detect';
export { CaptchaSolver } from './solver-interface';
export type { SolveRequest, SolveResult, SolverConfig, SolverError } from './solver-interface';
export { SolverRegistry, getSolverRegistry } from './solver-registry';
export type { SolverProvider, CostTracker } from './solver-registry';
export type { CaptchaType, CaptchaDetectionResult, CaptchaSiteKey } from '../types/captcha';
