/**
 * Version utility - reads version from package.json to avoid hardcoded strings
 */

import { readFileSync } from 'fs';
import { join } from 'path';

let _version: string | null = null;

export function getVersion(): string {
  if (!_version) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
      _version = pkg.version;
    } catch {
      _version = 'unknown';
    }
  }
  return _version!;
}
