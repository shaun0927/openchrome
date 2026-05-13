export { validateSchema, validateAndCoerce } from './schema-validator';
export type { ExtractionSchema, SchemaProperty, ValidationResult } from './schema-validator';
export {
  buildJsonLdExtractor,
  buildMicrodataExtractor,
  buildOpenGraphExtractor,
  buildCssHeuristicExtractor,
  buildMultipleItemExtractor,
} from './strategies';
export type { StrategyResult } from './strategies';
export { buildExtractionPlan, buildFieldPlan, isSafeSelectorToken } from './plan';
export type { ExtractionPlan, ExtractionFieldPlan } from './plan';
<<<<<<< HEAD
export { buildExtractionQueryPlan, parseExtractionQuery, ExtractionQueryParseError } from './query-parser';
export type { ExtractionQueryPlan } from './query-parser';
=======
>>>>>>> origin/feat/974-schema-aware-extract
