/**
 * Check: macos-perms
 * (macOS only) Attempts to read TCC.db to detect Screen Recording / Accessibility grants.
 *
 * In practice, reading TCC.db requires Full Disk Access on macOS 10.14+.
 * This check is EXPECTED to return 'skip' on the vast majority of macOS systems.
 * The primary value is the remediation message.
 */

import * as os from 'os';
import * as path from 'path';
import type { CheckFn } from '../../doctor';

const REMEDIATION = 'If headed Chrome misbehaves on macOS 14+, grant Screen Recording and Accessibility to your terminal in System Settings → Privacy & Security. Run `openchrome info` for details.';

export const checkMacosPerms: CheckFn = async () => {
  if (os.platform() !== 'darwin') {
    return {
      id: 'macos-perms',
      title: 'macOS permissions (TCC)',
      status: 'skip',
      detail: 'Not macOS',
    };
  }

  const tccDb = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'com.apple.TCC',
    'TCC.db',
  );

  // Try to read the TCC.db using the system sqlite3 binary
  // This will succeed only if the terminal has Full Disk Access
  try {
    const { execFileSync } = require('child_process');
    const output: string = execFileSync(
      'sqlite3',
      [tccDb, 'SELECT service,client,allowed FROM access WHERE service IN ("kTCCServiceScreenCapture","kTCCServiceAccessibility") LIMIT 20;'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const lines = output.trim().split('\n').filter(l => l.length > 0);
    if (lines.length === 0) {
      return {
        id: 'macos-perms',
        title: 'macOS permissions (TCC)',
        status: 'warn',
        detail: 'TCC.db readable but no Screen Recording / Accessibility entries found',
        remediation: REMEDIATION,
      };
    }

    const hasScreenRecording = lines.some(l => l.includes('kTCCServiceScreenCapture') && l.endsWith('|1'));
    const hasAccessibility = lines.some(l => l.includes('kTCCServiceAccessibility') && l.endsWith('|1'));

    if (hasScreenRecording && hasAccessibility) {
      return {
        id: 'macos-perms',
        title: 'macOS permissions (TCC)',
        status: 'ok',
        detail: 'Screen Recording and Accessibility granted to terminal',
      };
    }

    const missing: string[] = [];
    if (!hasScreenRecording) missing.push('Screen Recording');
    if (!hasAccessibility) missing.push('Accessibility');

    return {
      id: 'macos-perms',
      title: 'macOS permissions (TCC)',
      status: 'warn',
      detail: `Missing: ${missing.join(', ')}`,
      remediation: REMEDIATION,
    };
  } catch {
    // Expected: Full Disk Access not granted — return skip
    return {
      id: 'macos-perms',
      title: 'macOS permissions (TCC)',
      status: 'skip',
      detail: 'TCC.db not readable (Full Disk Access not granted — this is normal)',
      remediation: REMEDIATION,
    };
  }
};
