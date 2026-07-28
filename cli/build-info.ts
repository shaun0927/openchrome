import * as fs from 'fs';
import * as path from 'path';

export interface OpenChromeBuildInfo {
  version: string;
  sourceCommit: string;
  target: string;
  bundler: string;
  standalone: boolean;
}

function packageVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  for (const packageJsonPath of candidates) {
    try {
      return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version as string;
    } catch {
      // Try the source-tree and compiled-layout candidates in order.
    }
  }
  return 'unknown';
}

export function getBuildInfo(): OpenChromeBuildInfo {
  return {
    version: process.env.OPENCHROME_BUILD_VERSION || packageVersion(),
    sourceCommit: process.env.OPENCHROME_BUILD_COMMIT || 'unknown',
    target: process.env.OPENCHROME_BUILD_TARGET || `${process.platform}-${process.arch}`,
    bundler: process.env.OPENCHROME_BUILD_BUNDLER || `node-${process.version}`,
    standalone: process.env.OPENCHROME_STANDALONE_BINARY === '1',
  };
}
