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
 * Options required when invoking the Claude CLI with execFile/execFileSync.
 *
 * On Windows, `.cmd` shims need a shell. On POSIX platforms we keep the
 * existing shell-free behavior for safety and argument fidelity.
 */
export function getClaudeExecFileOptions(
  stdio: StdioOptions,
  platform: NodeJS.Platform = process.platform
): { stdio: StdioOptions; shell?: boolean } {
  return platform === 'win32' ? { stdio, shell: true } : { stdio };
}
