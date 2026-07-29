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
  ConsoleAssertion,
  Evidence,
  EvaluationResult,
  LeafAssertion,
  NetworkAssertion,
  NetworkSinceMarker,
  NoDialogAssertion,
  NotAssertion,
  OrAssertion,
  PerformanceAssertion,
  ScreenshotClassAssertion,
  UrlAssertion,
} from './types';
export type {
  ConsoleContractFact,
  ConsoleContractFactEntry,
  ConsoleFactMessageEncoding,
  ContractFact,
  ContractFactBase,
  ContractFactErrorCode,
  PerformanceContractFact,
  PerformanceUnit,
} from './contract-facts';
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
  CONTRACT_FACT_SCHEMA_VERSION,
  MAX_CONSOLE_FACT_ENTRIES,
  MAX_CONSOLE_FACT_CAPTURE_TYPES,
  MAX_CONSOLE_FACT_MESSAGE_CHARS,
  MAX_CONTRACT_FACT_AGE_MS,
  MAX_CONTRACT_FACTS,
  buildConsoleContractFact,
  buildPerformanceContractFacts,
  selectConsoleContractFact,
  selectPerformanceContractFact,
} from './contract-facts';
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
