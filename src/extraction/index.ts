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
