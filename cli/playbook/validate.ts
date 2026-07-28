import { expandStep } from './expand';
import type { Playbook, Verb } from './parse';
import { injectCurrentTab } from './run';
import {
  validateValueAgainstSchema,
  type JsonSchema,
  type SchemaSeverity,
} from './schema-validator';
import {
  RegisteredToolManifestClient,
  type McpToolDefinition,
  type ToolDefinitionSource,
} from './tool-manifest-client';
import { substituteValue } from './vars';

const VALIDATION_TAB_ID = '__openchrome_playbook_validation_tab__';

export interface ValidationDiagnostic {
  stepIndex: number;
  id?: string;
  verb: Verb;
  tool: string;
  severity: SchemaSeverity;
  code: string;
  instancePath: string;
  schemaPath: string;
  message: string;
}

export interface ValidationSummary {
  ok: boolean;
  total: number;
  errors: number;
  warnings: number;
}

export interface ValidationResult {
  name: string | undefined;
  diagnostics: ValidationDiagnostic[];
  summary: ValidationSummary;
}

export interface ValidateOptions {
  varMap: Record<string, string>;
  source?: ToolDefinitionSource;
}

interface PreparedStep {
  index: number;
  id?: string;
  verb: Verb;
  tool: string;
  callArgs: Record<string, unknown>;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'boolean' || (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function prepareSteps(playbook: Playbook, varMap: Record<string, string>): PreparedStep[] {
  let currentTabId: string | undefined;
  return playbook.steps.map((step, index) => {
    const substitutedArgs = substituteValue(step.args, varMap, index) as Record<string, unknown>;
    const callArgs = injectCurrentTab(step.verb, substitutedArgs, currentTabId);
    const expanded = expandStep(step.verb, callArgs);
    if (step.verb === 'navigate') {
      currentTabId = VALIDATION_TAB_ID;
    }
    return {
      index,
      ...(step.id !== undefined ? { id: step.id } : {}),
      verb: step.verb,
      tool: expanded.tool,
      callArgs: expanded.callArgs,
    };
  });
}

function missingToolDiagnostic(step: PreparedStep): ValidationDiagnostic {
  return {
    stepIndex: step.index,
    ...(step.id !== undefined ? { id: step.id } : {}),
    verb: step.verb,
    tool: step.tool,
    severity: 'error',
    code: 'tool.missing',
    instancePath: '',
    schemaPath: '',
    message: 'Expanded tool is not present in the registered MCP tool manifest.',
  };
}

function missingSchemaDiagnostic(step: PreparedStep): ValidationDiagnostic {
  return {
    stepIndex: step.index,
    ...(step.id !== undefined ? { id: step.id } : {}),
    verb: step.verb,
    tool: step.tool,
    severity: 'error',
    code: 'tool.schema_missing',
    instancePath: '',
    schemaPath: '',
    message: 'Registered MCP tool definition does not expose an input schema.',
  };
}

function indexDefinitions(definitions: McpToolDefinition[]): Map<string, McpToolDefinition> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

export async function validatePlaybook(
  playbook: Playbook,
  options: ValidateOptions,
): Promise<ValidationResult> {
  // Variable substitution intentionally finishes before manifest discovery.
  const preparedSteps = prepareSteps(playbook, options.varMap);
  const source = options.source ?? new RegisteredToolManifestClient();
  const definitions = await source.listToolDefinitions();

  const definitionsByName = indexDefinitions(definitions);
  const diagnostics: ValidationDiagnostic[] = [];

  for (const step of preparedSteps) {
    const definition = definitionsByName.get(step.tool);
    if (!definition) {
      diagnostics.push(missingToolDiagnostic(step));
      continue;
    }
    if (!isSchema(definition.inputSchema)) {
      diagnostics.push(missingSchemaDiagnostic(step));
      continue;
    }

    diagnostics.push(...validateValueAgainstSchema(step.callArgs, definition.inputSchema).map((entry) => ({
      stepIndex: step.index,
      ...(step.id !== undefined ? { id: step.id } : {}),
      verb: step.verb,
      tool: step.tool,
      ...entry,
    })));
  }

  const errors = diagnostics.filter((entry) => entry.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  return {
    name: playbook.name,
    diagnostics,
    summary: {
      ok: errors === 0,
      total: playbook.steps.length,
      errors,
      warnings,
    },
  };
}

export function validationExitCode(result: ValidationResult): 0 | 1 {
  return result.summary.ok ? 0 : 1;
}

export function formatValidationResult(result: ValidationResult, json: boolean): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;

  const status = result.summary.ok ? 'SCHEMA OK' : 'SCHEMA ERRORS';
  const name = result.name ?? '(unnamed playbook)';
  const lines = [
    `[playbook] ${status} ${name}: ${result.summary.total} steps, ` +
      `${result.summary.errors} errors, ${result.summary.warnings} warnings`,
  ];
  for (const entry of result.diagnostics) {
    const location = entry.instancePath || '/';
    const id = entry.id === undefined ? '' : ` [${entry.id}]`;
    lines.push(
      `[playbook] ${entry.severity.toUpperCase()} step ${entry.stepIndex}${id} ` +
        `(${entry.verb} -> ${entry.tool}) ${location} ${entry.code}: ${entry.message}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
