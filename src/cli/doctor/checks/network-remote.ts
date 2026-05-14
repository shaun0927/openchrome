/**
 * Check: network-remote
 * (opt-in, behind --remote flag) HEAD probe of update.googleapis.com to detect
 * captive portals / corporate proxies. OFF by default.
 *
 * When not opted in, returns 'skip' immediately.
 */

import type { CheckFn } from '../../doctor';

// This check is always skip when invoked directly; the runner gates on --remote
// by excluding it from the check list. This skip return covers the --check network-remote
// case when --remote is not passed, and also tests.
const REMOTE_HOST = 'https://update.googleapis.com';

export const checkNetworkRemote: CheckFn = async () => {
  // The doctor runner excludes this check unless --remote is passed.
  // If called directly (e.g. --check network-remote without --remote), return skip.
  if (!process.env.OPENCHROME_DOCTOR_REMOTE_ENABLED) {
    return {
      id: 'network-remote',
      title: 'Remote network (googleapis.com)',
      status: 'skip',
      detail: 'Opt-in check — pass --remote flag to enable',
    };
  }

  try {
    const resp = await fetch(REMOTE_HOST, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
    });
    return {
      id: 'network-remote',
      title: 'Remote network (googleapis.com)',
      status: resp.ok || resp.status < 500 ? 'ok' : 'warn',
      detail: `HEAD ${REMOTE_HOST} → HTTP ${resp.status}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: 'network-remote',
      title: 'Remote network (googleapis.com)',
      status: 'fail',
      detail: `HEAD ${REMOTE_HOST} failed: ${msg}`,
      remediation: 'Check your internet connection and proxy settings (HTTPS_PROXY / NO_PROXY)',
    };
  }
};
