/**
 * Var substitution for playbook steps.
 *
 * Regex: /\$\{([A-Za-z_][A-Za-z0-9_:]*)\}/g
 * - Plain identifiers (${url}, ${BASE_URL}) resolved from merged var map.
 * - ${SECRET:NAME} passed through with a stderr warning (until #834 lands).
 * - Unknown var → throws VarError (exit code 2).
 * CLI --vars override the playbook vars: block.
 */

export class VarError extends Error {
  constructor(
    message: string,
    public readonly varName: string,
    public readonly stepIndex?: number,
  ) {
    super(message);
    this.name = 'VarError';
  }
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_:]*)\}/g;

/**
 * Build merged var map: playbook vars: block is the base; CLI --vars override.
 */
export function buildVarMap(
  playbookVars: Record<string, string> | undefined,
  cliVars: Record<string, string>,
): Record<string, string> {
  return { ...(playbookVars ?? {}), ...cliVars };
}

/**
 * Substitute ${VAR} in a single string. Returns the substituted string.
 * Throws VarError for unknown vars. Warns (stderr) for SECRET: namespace.
 */
export function substituteString(
  value: string,
  varMap: Record<string, string>,
  stepIndex?: number,
): string {
  return value.replace(VAR_RE, (_match, name: string) => {
    if (name.startsWith('SECRET:')) {
      // Pass-through with warning — masking layer from #834 not yet merged.
      console.error(
        `[playbook] WARNING: ${name} is a secret reference; masking layer (#834) not yet merged. Value will be used as-is from var map if present.`,
      );
      // Fall through to normal lookup
    }
    if (Object.prototype.hasOwnProperty.call(varMap, name)) {
      return varMap[name];
    }
    const stepMsg = stepIndex !== undefined ? ` (step ${stepIndex})` : '';
    throw new VarError(
      `Unknown variable "\${${name}}"${stepMsg}. Define it in the vars: block or pass --vars ${name}=<value>.`,
      name,
      stepIndex,
    );
  });
}

/**
 * Recursively walk the step args tree and substitute all string scalars.
 */
export function substituteValue(
  value: unknown,
  varMap: Record<string, string>,
  stepIndex?: number,
): unknown {
  if (typeof value === 'string') {
    return substituteString(value, varMap, stepIndex);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, varMap, stepIndex));
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteValue(v, varMap, stepIndex);
    }
    return result;
  }
  return value;
}

/**
 * Parse --vars CLI arguments of the form KEY=VALUE.
 * Returns a Record<string, string>.
 */
export function parseCliVars(vars: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of vars) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx === -1) {
      throw new VarError(
        `Invalid --vars entry "${entry}". Expected format: KEY=VALUE`,
        entry,
      );
    }
    const key = entry.slice(0, eqIdx);
    const val = entry.slice(eqIdx + 1);
    result[key] = val;
  }
  return result;
}
