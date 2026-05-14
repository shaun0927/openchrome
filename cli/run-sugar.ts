export interface SugarCommandSpec {
  command: string;
  description: string;
  tool: string;
  args: Array<{ name: string; required?: boolean; variadic?: boolean }>;
}

export const RUN_SUGAR_COMMANDS: SugarCommandSpec[] = [
  { command: 'navigate <url>', description: 'Run navigate with a positional URL.', tool: 'navigate', args: [{ name: 'url', required: true }] },
  { command: 'tabs_create <url>', description: 'Run tabs_create with a positional URL.', tool: 'tabs_create', args: [{ name: 'url', required: true }] },
  { command: 'read_page', description: 'Run read_page.', tool: 'read_page', args: [] },
  { command: 'page_screenshot [path]', description: 'Run page_screenshot with an optional output path.', tool: 'page_screenshot', args: [{ name: 'path' }] },
  { command: 'tabs_context', description: 'Run tabs_context.', tool: 'tabs_context', args: [] },
  { command: 'tabs_close <tabId>', description: 'Run tabs_close with a positional tab id.', tool: 'tabs_close', args: [{ name: 'tabId', required: true }] },
  { command: 'wait_for <selector>', description: 'Run wait_for with a selector.', tool: 'wait_for', args: [{ name: 'selector', required: true }] },
  { command: 'click <ref>', description: 'Run click with a ref/selector argument.', tool: 'click', args: [{ name: 'ref', required: true }] },
  { command: 'interact <ref> <action>', description: 'Run interact with ref and action.', tool: 'interact', args: [{ name: 'ref', required: true }, { name: 'action', required: true }] },
  { command: 'form_input <ref> <value>', description: 'Run form_input with ref and value.', tool: 'form_input', args: [{ name: 'ref', required: true }, { name: 'value', required: true }] },
  { command: 'javascript_tool <code>', description: 'Run javascript_tool with code.', tool: 'javascript_tool', args: [{ name: 'code', required: true }] },
  { command: 'oc_assert <contract>', description: 'Run oc_assert with a JSON contract.', tool: 'oc_assert', args: [{ name: 'contract', required: true }] },
];

export function resolveSugarArgs(spec: SugarCommandSpec, values: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < spec.args.length; i++) {
    const arg = spec.args[i];
    const value = values[i];
    if ((value === undefined || value === '') && arg.required) {
      throw new Error(`Missing required positional argument ${arg.name}`);
    }
    if (value !== undefined) {
      out[arg.name] = parseSugarValue(arg.name, value);
    }
  }
  return out;
}

function parseSugarValue(name: string, value: string): unknown {
  if (name === 'contract') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}
