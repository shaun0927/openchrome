import { Command } from 'commander';
import { StdioRunClient, TransportError, type McpToolCallResult } from './run-stdio-client';
import { RUN_SUGAR_COMMANDS, resolveSugarArgs, type SugarCommandSpec } from './run-sugar';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RunOptions {
  arg?: string[];
  json?: boolean;
  reuse?: boolean;
}

export function parseArgValue(raw: string): unknown {
  if (raw.startsWith('json:')) {
    return JSON.parse(raw.slice('json:'.length)) as unknown;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

export function parseArgAssignments(assignments: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const idx = assignment.indexOf('=');
    if (idx <= 0) {
      throw new UsageError(`Invalid --arg "${assignment}". Expected key=value.`);
    }
    const key = assignment.slice(0, idx);
    const raw = assignment.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new UsageError(`Invalid --arg key "${key}".`);
    }
    if (isUnsafeArgKey(key)) {
      throw new UsageError(`Unsafe --arg key "${key}".`);
    }
    try {
      out[key] = parseArgValue(raw);
    } catch (err) {
      throw new UsageError(`Invalid JSON for --arg ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

function isUnsafeArgKey(key: string): boolean {
  return key
    .split(/[.-]/)
    .some((part) => part === '__proto__' || part === 'prototype' || part === 'constructor');
}

export function mergeArgs(positional: Record<string, unknown>, options: RunOptions): Record<string, unknown> {
  return { ...positional, ...parseArgAssignments(options.arg ?? []) };
}

export function formatHumanResult(result: McpToolCallResult): string {
  const firstText = result.content?.find((entry) => entry.type === 'text' && typeof entry.text === 'string')?.text;
  if (firstText !== undefined) return firstText;
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  return JSON.stringify(result, null, 2);
}

async function executeTool(tool: string, args: Record<string, unknown>, options: RunOptions): Promise<number> {
  const client = new StdioRunClient();
  try {
    await client.connect(Boolean(options.reuse));
    const tools = await client.listTools();
    if (!tools.has(tool)) {
      throw new UsageError(`Unknown tool "${tool}".`);
    }
    const result = await client.callTool(tool, args);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatHumanResult(result)}\n`);
    }
    return result.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}

async function runAndExit(tool: string, args: Record<string, unknown>, options: RunOptions): Promise<void> {
  try {
    const code = await executeTool(tool, args, options);
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`[oc run] ${err.message}`);
      process.exit(2);
    }
    if (err instanceof TransportError) {
      console.error(`[oc run] Transport error: ${err.message}`);
      process.exit(3);
    }
    console.error(`[oc run] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  }
}

function collectArg(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function registerRunCommand(program: Command): void {
  program.option('--reuse', 'For oc run: attempt to reuse an existing OpenChrome daemon when supported.', false);

  program
    .command('run <tool>')
    .description('Run one MCP tool through a one-shot stdio OpenChrome server (issue #843).')
    .option('--arg <key=value>', 'Tool argument assignment. Repeatable. Prefix value with json: for JSON.', collectArg, [] as string[])
    .option('--json', 'Emit raw MCP tool result JSON.', false)
    .option('--reuse', 'Attempt to reuse an existing OpenChrome daemon when supported.', false)
    .action(async (tool: string, options: RunOptions) => {
      const global = program.opts<{ reuse?: boolean }>();
      await runAndExit(tool, parseArgAssignments(options.arg ?? []), { ...options, reuse: options.reuse || global.reuse });
    });

  for (const spec of RUN_SUGAR_COMMANDS) {
    registerSugarCommand(program, spec);
  }
}

function registerSugarCommand(program: Command, spec: SugarCommandSpec): void {
  program
    .command(spec.command)
    .description(spec.description)
    .option('--arg <key=value>', 'Additional tool argument assignment. Repeatable. Overrides positional args.', collectArg, [] as string[])
    .option('--json', 'Emit raw MCP tool result JSON.', false)
    .option('--reuse', 'Attempt to reuse an existing OpenChrome daemon when supported.', false)
    .action(async (...actionArgs: unknown[]) => {
      const options = actionArgs[actionArgs.length - 1] as RunOptions;
      const values = actionArgs.slice(0, -1).filter((value): value is string => typeof value === 'string');
      const global = program.opts<{ reuse?: boolean }>();
      const positional = resolveSugarArgs(spec, values);
      await runAndExit(spec.tool, mergeArgs(positional, options), { ...options, reuse: options.reuse || global.reuse });
    });
}
