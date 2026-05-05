import type { StdioOptions } from 'child_process';

/**
 * Return the Claude CLI executable name for the current platform.
 *
 * npm global executables on Windows are exposed as `.cmd` shims. Node cannot
 * reliably execute those shims as bare extensionless commands from execFile(),
 * so callers should use this helper for every direct Claude CLI invocation.
 */
export function getClaudeCliCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'claude.cmd' : 'claude';
}

/**
 * Return whether direct Claude CLI invocations need to run through a shell.
 *
 * Windows `.cmd` shims require shell execution; POSIX platforms should keep
 * shell-free process execution for safety and argument fidelity.
 */
export function shouldUseClaudeCliShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * Options required when invoking the Claude CLI with execFile/execFileSync.
 */
export function getClaudeExecFileOptions(
  stdio: StdioOptions,
  platform: NodeJS.Platform = process.platform
): { stdio: StdioOptions; shell?: boolean } {
  return shouldUseClaudeCliShell(platform) ? { stdio, shell: true } : { stdio };
}
