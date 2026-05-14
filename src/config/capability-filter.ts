import { TOOL_CAPABILITIES, type ToolCapability } from '../types/mcp';

export interface CapabilityFilterCliOptions {
  slim?: boolean;
  toolsOnly?: string;
  disableTools?: string;
}

export interface CapabilityFilterResolution {
  capabilityFilter?: Set<ToolCapability>;
  logMessage?: string;
  errorMessage?: string;
}

function parseCapabilityCsv(value: string): ToolCapability[] {
  return value.split(',').map(s => s.trim()).filter(Boolean) as ToolCapability[];
}

function validateCapabilities(
  values: readonly ToolCapability[],
  allCapabilities: readonly ToolCapability[],
): string | undefined {
  const invalid = values.filter(c => !allCapabilities.includes(c));
  if (invalid.length === 0) {
    return undefined;
  }

  return `[openchrome] Error: unknown capability group(s): ${invalid.join(', ')}. Valid: ${allCapabilities.join(', ')}`;
}

export function resolveCapabilityFilterOptions(
  options: CapabilityFilterCliOptions,
  allCapabilities: readonly ToolCapability[] = TOOL_CAPABILITIES,
): CapabilityFilterResolution {
  const enabledModes = [
    options.slim ? '--slim' : undefined,
    options.toolsOnly ? '--tools-only' : undefined,
    options.disableTools ? '--disable-tools' : undefined,
  ].filter(Boolean);

  if (enabledModes.length > 1) {
    return {
      errorMessage: '[openchrome] Error: --slim, --tools-only, and --disable-tools are mutually exclusive',
    };
  }

  if (options.slim) {
    const requested: ToolCapability[] = ['core'];
    return {
      capabilityFilter: new Set(requested),
      logMessage: `[openchrome] Capability filter (slim): ${requested.join(', ')}`,
    };
  }

  if (options.toolsOnly) {
    const requested = parseCapabilityCsv(options.toolsOnly);
    const errorMessage = validateCapabilities(requested, allCapabilities);
    if (errorMessage) {
      return { errorMessage };
    }

    return {
      capabilityFilter: new Set(requested),
      logMessage: `[openchrome] Capability filter (tools-only): ${requested.join(', ')}`,
    };
  }

  if (options.disableTools) {
    const disabled = parseCapabilityCsv(options.disableTools);
    const errorMessage = validateCapabilities(disabled, allCapabilities);
    if (errorMessage) {
      return { errorMessage };
    }

    const allowed = allCapabilities.filter(c => !disabled.includes(c));
    return {
      capabilityFilter: new Set(allowed),
      logMessage: `[openchrome] Capability filter (disable-tools): disabled=${disabled.join(', ')}`,
    };
  }

  return {};
}
