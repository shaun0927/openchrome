/**
 * Check: optional-deps
 * Tries to import optional native modules and reports which ones loaded.
 * Enumerates entries from package.json optionalDependencies at runtime.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { CheckFn } from '../../doctor';

function getOptionalDeps(): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../../package.json'), 'utf8'));
    const deps = pkg?.optionalDependencies ?? {};
    return Object.keys(deps);
  } catch {
    return [];
  }
}

async function tryRequire(name: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(name);
    return true;
  } catch {
    return false;
  }
}

export const checkOptionalDeps: CheckFn = async () => {
  // Always check argon2 as the spec calls it out explicitly
  const depsFromPkg = getOptionalDeps();
  const toCheck = Array.from(new Set(['argon2', ...depsFromPkg]));

  const results: { name: string; loaded: boolean }[] = [];
  for (const dep of toCheck) {
    const loaded = await tryRequire(dep);
    results.push({ name: dep, loaded });
  }

  const failed = results.filter(r => !r.loaded);
  const succeeded = results.filter(r => r.loaded);

  if (results.length === 0) {
    return {
      id: 'optional-deps',
      title: 'Optional native deps',
      status: 'ok',
      detail: 'No optional dependencies declared',
    };
  }

  if (failed.length === 0) {
    return {
      id: 'optional-deps',
      title: 'Optional native deps',
      status: 'ok',
      detail: `All ${succeeded.length} optional dep(s) loaded: ${succeeded.map(r => r.name).join(', ')}`,
    };
  }

  // Some optional deps failed to load — this is expected (they are optional)
  const failedNames = failed.map(r => r.name).join(', ');
  const okNames = succeeded.length > 0 ? `; loaded: ${succeeded.map(r => r.name).join(', ')}` : '';

  return {
    id: 'optional-deps',
    title: 'Optional native deps',
    status: 'warn',
    detail: `Missing optional dep(s): ${failedNames}${okNames}`,
    remediation: `Run: npm install ${failed.map(r => r.name).join(' ')}  (optional — openchrome works without them)`,
  };
};
