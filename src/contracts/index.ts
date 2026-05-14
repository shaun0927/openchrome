/**
 * Public surface of the Outcome Contracts DSL (issue #705).
 *
 * The runtime that drives these primitives lives in #706; this module
 * is intentionally I/O-free except for the on-disk screenshot-class
 * registry.
 */

export type {
  Assertion,
  AndAssertion,
  ComparisonOp,
  DomCountAssertion,
  DomTextAssertion,
  Evidence,
  EvaluationResult,
  LeafAssertion,
  NetworkAssertion,
  NetworkSinceMarker,
  NoDialogAssertion,
  NotAssertion,
  OrAssertion,
  ScreenshotClassAssertion,
  UrlAssertion,
} from './types';
export type {
  BrowserTaskBudgets,
  BrowserTaskLoopGuard,
  BrowserTaskSignature,
  BrowserTaskSignatureInputSpec,
  TaskSignatureEvaluationInput,
  TaskSignatureInputRedaction,
  TaskSignatureInputType,
  TaskSignatureLoopGuardKind,
  TaskSignatureStatus,
  TaskSignatureToolCallSummary,
} from './task-signature';

export type { EvalContext, NetworkLogEntry } from './eval-context';
export type { ValidationError, ValidationResult } from './validator';
export type {
  LoadedScreenshotClass,
  ScoreResult,
  ScreenshotClassMetadata,
} from './screenshot-class';

export { validateAssertion } from './validator';
export {
  evaluateTaskSignature,
  preflightAllowedTools,
  redactTaskSignatureInputs,
  validateBrowserTaskSignature,
} from './task-signature';
export { evaluate } from './evaluate';
export {
  hamming,
  phashFromHex,
  phashFromPng,
  phashFromRgba,
  phashToHex,
} from './phash';
export { decodePng } from './png-decode';
export {
  classDir,
  defaultClassesDir,
  loadClass,
  recommendThreshold,
  scoreHash,
  teachClass,
} from './screenshot-class';
export { createChromeEvalContext } from './chrome-eval-context';
