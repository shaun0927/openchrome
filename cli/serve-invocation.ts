import * as path from 'path';

export interface ServeInvocation {
  command: string;
  args: string[];
}

export function resolveServeInvocation(
  compiledServeEntry: string,
  serveArgs: readonly string[] = [],
): ServeInvocation {
  return {
    command: process.execPath,
    args: [path.resolve(compiledServeEntry), 'serve', ...serveArgs],
  };
}
