/**
 * Plan Cache Types - Compiled Plan Cache for repeated task patterns
 *
 * Enables server-side execution of cached tool sequences,
 * bypassing per-step agent LLM round-trips.
 */

/** A single step in a compiled plan */
export interface CompiledStep {
  /** Execution order (1-based) */
  order: number;
  /** MCP tool name (e.g. "javascript_tool", "computer") */
  tool: string;
  /** Tool arguments — supports ${param} template variables */
  args: Record<string, unknown>;
  /** Step-level timeout in milliseconds */
  timeout: number;
  /** Whether to retry this step on failure */
  retryOnFail?: boolean;
  /** How to parse and store the result for subsequent steps */
  parseResult?: {
    format: 'json' | 'text';
    /** JSON field to extract from result */
    extractField?: string;
    /** Variable name to store result for later steps */
    storeAs?: string;
  };
}

/** Error handler for a compiled plan */
export interface PlanErrorHandler {
  /** Condition that triggers this handler (e.g. "step2_empty_result") */
  condition: string;
  /** Human-readable action name */
  action: string;
  /** Recovery steps to execute */
  steps: CompiledStep[];
}

/** Success criteria for plan validation */
export interface PlanSuccessCriteria {
  /** Minimum number of data items in result */
  minDataItems?: number;
  /** Required fields in extracted data */
  requiredFields?: string[];
  /** Custom validation JS expression (evaluated against params) */
  customCheck?: string;
}

/** Task pattern for matching incoming tasks to cached plans */
export interface TaskPattern {
  /** URL regex pattern (e.g. "https://x\\.com/.*") */
  urlPattern?: string;
  /** Required keywords in task description (AND logic) */
  taskKeywords: string[];
  /** Expected tool sequence signature */
  toolSequence?: string[];
  /** DOM structure selector to verify page compatibility */
  pageStructure?: string;
}

/** A complete compiled plan — a cached sequence of tool calls */
export interface CompiledPlan {
  /** Unique plan identifier */
  id: string;
  /** Plan version for cache invalidation */
  version: string;
  /** Human-readable description */
  description: string;
  /** Parameters with sources and defaults */
  parameters: Record<string, {
    source?: 'worker_config' | 'task_args' | 'runtime';
    default?: unknown;
  }>;
  /** Ordered execution steps */
  steps: CompiledStep[];
  /** Error handlers */
  errorHandlers: PlanErrorHandler[];
  /** Success validation criteria */
  successCriteria: PlanSuccessCriteria;
}

/** Registry entry for a plan with usage statistics */
export interface PlanEntry {
  /** Plan ID */
  id: string;
  /** Task matching pattern */
  pattern: TaskPattern;
  /** Path to the plan JSON file */
  planPath: string;
  /** Usage statistics */
  stats: {
    totalExecutions: number;
    successCount: number;
    failCount: number;
    avgDurationMs: number;
    lastUsed: number;
  };
  /** Confidence score (0.0 - 1.0) based on success rate */
  confidence: number;
  /** Minimum confidence required to use this plan */
  minConfidenceToUse: number;
}

/** The plan registry index */
export interface PlanRegistryData {
  version: string;
  plans: PlanEntry[];
  updatedAt: number;
}

/** Result of plan execution */
export interface PlanExecutionResult {
  /** Whether the plan executed successfully */
  success: boolean;
  /** Plan ID that was executed */
  planId: string;
  /** Extracted data (if successful) */
  data?: Record<string, unknown>;
  /** Error message (if failed) */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Number of steps executed */
  stepsExecuted: number;
  /** Total steps in plan */
  totalSteps: number;
}
