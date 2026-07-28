import * as path from 'path';

export interface ServeInvocation {
  command: string;
  args: string[];
}

export function resolveServeInvocation(
  compiledServeEntry: string,
  serveArgs: readonly string[] = [],
): ServeInvocation {
  if (process.env.OPENCHROME_STANDALONE_BINARY === '1') {
    return {
      command: process.execPath,
      args: ['serve', ...serveArgs],
    };
  }

  return {
    command: process.execPath,
    args: [path.resolve(compiledServeEntry), 'serve', ...serveArgs],
  };
}
