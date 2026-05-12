/**
 * Check: home-writable
 * Verifies ~/.openchrome/ exists and is writable.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CheckFn } from '../../doctor';

export const checkHomeWritable: CheckFn = async () => {
  const dir = path.join(os.homedir(), '.openchrome');

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      id: 'home-writable',
      title: '~/.openchrome/ writable',
      status: 'fail',
      detail: `Cannot create ${dir}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
      remediation: `Run: mkdir -p ${dir} && chmod 755 ${dir}`,
    };
  }

  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return {
      id: 'home-writable',
      title: '~/.openchrome/ writable',
      status: 'ok',
      detail: dir,
    };
  } catch {
    return {
      id: 'home-writable',
      title: '~/.openchrome/ writable',
      status: 'fail',
      detail: `${dir} is not writable`,
      remediation: `Run: chmod 755 ${dir}`,
    };
  }
};
