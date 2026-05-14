/**
 * Check: node-version
 * Verifies Node.js meets the minimum version in package.json engines field.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { CheckFn } from '../../doctor';

function parseMinVersion(range: string): number | null {
  // Handles ">=18.0.0", "^18", "18", etc.
  const match = range.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export const checkNodeVersion: CheckFn = async () => {
  let engineRange = '>=18.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../../package.json'), 'utf8'));
    engineRange = pkg?.engines?.node ?? engineRange;
  } catch {
    // Use default if we can't read package.json
  }

  const current = process.versions.node;
  const currentMajor = parseInt(current.split('.')[0], 10);
  const minMajor = parseMinVersion(engineRange) ?? 18;

  if (currentMajor >= minMajor) {
    return {
      id: 'node-version',
      title: 'Node.js version',
      status: 'ok',
      detail: `v${current} (required: ${engineRange})`,
    };
  }

  return {
    id: 'node-version',
    title: 'Node.js version',
    status: 'fail',
    detail: `v${current} (required: ${engineRange})`,
    remediation: `Upgrade Node.js to ${engineRange} — https://nodejs.org`,
  };
};
