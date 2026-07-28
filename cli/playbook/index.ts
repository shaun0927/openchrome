/**
 * Playbook subcommand registration.
 *
 * Registers playbook run and validation commands onto the given Commander program.
 *
 * Exit codes:
 *   0 — all steps + all asserts pass
 *   1 — at least one step or assert failed
 *   2 — usage / parse / unknown-var
 *   3 — io / spawn / transport failure
 */

import { Command } from 'commander';
import * as path from 'path';
import { loadPlaybook, ParseError } from './parse';
import { buildVarMap, parseCliVars, VarError } from './vars';
import { runPlaybook } from './run';
import { writeReport } from './report';
import { TransportError as PlaybookTransportError } from './stdio-client';
import {
  formatValidationResult,
  validatePlaybook,
  validationExitCode,
} from './validate';
import { ToolManifestError } from './tool-manifest-client';

function collectVar(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function registerPlaybookCommand(program: Command): void {
  const playbook = program
    .command('playbook')
    .description('Declarative YAML/JSON scenario runner (issue #854).');

  playbook
    .command('run <file>')
    .description('Execute a playbook file against the MCP server.')
    .option('--vars <k=v...>', 'Variable overrides (repeatable). CLI values override the vars: block.', collectVar, [] as string[])
    .option('--out <path>', 'Write a Markdown report to this file.')
    .option('--reuse', 'Connect to an existing openchrome serve daemon instead of spawning a new one.', false)
    .option('--json', 'Output the full run report as JSON on stdout.', false)
    .action(async (file: string, options: { vars: string[]; out?: string; reuse: boolean; json: boolean }) => {
      const filePath = path.resolve(file);

      // Phase 1: parse
      let playbook;
      try {
        playbook = loadPlaybook(filePath);
      } catch (err) {
        if (err instanceof ParseError) {
          const lineInfo = err.line !== undefined ? ` (line ${err.line})` : '';
          console.error(`[playbook] Parse error${lineInfo}: ${err.message}`);
        } else {
          console.error(`[playbook] Failed to load playbook: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(2);
      }

      // Phase 2: build var map
      let cliVars: Record<string, string>;
      try {
        cliVars = parseCliVars(options.vars);
      } catch (err) {
        console.error(`[playbook] --vars error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }

      const varMap = buildVarMap(playbook.vars, cliVars);

      // Phase 3: run
      let result;
      try {
        result = await runPlaybook(playbook, {
          reuse: options.reuse,
          varMap,
        });
      } catch (err) {
        if (err instanceof PlaybookTransportError) {
          console.error(`[playbook] Transport error: ${err.message}`);
          process.exit(3);
        }
        if (err instanceof VarError) {
          console.error(`[playbook] Variable error: ${err.message}`);
          process.exit(2);
        }
        console.error(`[playbook] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(3);
      }

      // Phase 4: report
      try {
        writeReport(result, { json: options.json, outPath: options.out });
      } catch (err) {
        console.error(`[playbook] Report error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(3);
      }

      process.exit(result.summary.ok ? 0 : 1);
    });

  const validate = playbook
    .command('validate <file>')
    .description('Validate a playbook against the registered MCP tool schemas without executing tools.')
    .option('--vars <k=v...>', 'Variable overrides (repeatable). CLI values override the vars: block.', collectVar, [] as string[])
    .option('--reuse', 'Reserved for session-scoped daemon validation; not supported yet.', false)
    .option('--json', 'Output structured validation diagnostics as JSON.', false);

  validate.exitOverride((error) => {
    process.exit(error.exitCode === 0 ? 0 : 2);
  });

  validate.action(async (file: string, options: { vars: string[]; reuse: boolean; json: boolean }) => {
    const filePath = path.resolve(file);

    let parsed;
    try {
      parsed = loadPlaybook(filePath);
    } catch (err) {
      if (err instanceof ParseError) {
        const lineInfo = err.line !== undefined ? ` (line ${err.line})` : '';
        console.error(`[playbook] Parse error${lineInfo}: ${err.message}`);
      } else {
        console.error(`[playbook] Failed to load playbook: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(2);
    }

    let cliVars: Record<string, string>;
    try {
      cliVars = parseCliVars(options.vars);
    } catch (err) {
      console.error(`[playbook] --vars error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }

    const varMap = buildVarMap(parsed.vars, cliVars);
    try {
      if (options.reuse === true || program.opts<{ reuse?: boolean }>().reuse === true) {
        console.error(
          '[playbook] --reuse is not supported for schema validation yet; ' +
          'validate against the registered local manifest instead.',
        );
        process.exit(2);
      }
      const result = await validatePlaybook(parsed, {
        varMap,
      });
      await writeStdout(formatValidationResult(result, options.json));
      process.exit(validationExitCode(result));
    } catch (err) {
      if (err instanceof VarError) {
        console.error(`[playbook] Variable error: ${err.message}`);
        process.exit(2);
      }
      if (err instanceof ToolManifestError) {
        console.error(`[playbook] Manifest error: ${err.message}`);
        process.exit(3);
      }
      console.error(`[playbook] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(3);
    }
  });
}
