/**
 * CAPTCHA module - detection, classification, and solving (#574)
 */

export { detectCaptcha } from './detect';
export { CaptchaSolver } from './solver-interface';
export type { SolveRequest, SolveResult, SolverConfig, SolverError } from './solver-interface';
export { SolverRegistry, getSolverRegistry, waitForSolverReady } from './solver-registry';
export type { SolverProvider, CostTracker } from './solver-registry';
export { handleCaptcha, checkDomainCaptchaHistory } from './handler';
export type { CaptchaHandleResult } from './handler';
export { injectSolution } from './inject-solution';
export type { CaptchaType, CaptchaDetectionResult, CaptchaSiteKey } from '../types/captcha';
