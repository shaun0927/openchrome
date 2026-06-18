/**
 * Check: duplicate-controllers
 * Surfaces unsafe multi-controller OpenChrome topologies before they cause CDP disconnects.
 */

import * as os from 'os';
import * as path from 'path';
import type { CheckFn } from '../../doctor';
import { getCurrentControllerTopology, summarizeDuplicateControllerDiagnostics } from '../../../utils/duplicate-controller-diagnostics';

function displayPath(filePath: string): string {
  const homes = [os.homedir()];
  try {
    homes.push(os.userInfo().homedir);
  } catch {
    // Best-effort redaction only.
  }

  const normalizedHomes = Array.from(new Set(homes.filter(Boolean)))
    .sort((a, b) => b.length - a.length);
  for (const home of normalizedHomes) {
    if (filePath === home) return '~';
    if (filePath.startsWith(`${home}${path.sep}`)) return `~/${filePath.slice(home.length + 1)}`;
  }
  return filePath;
}

export const checkDuplicateControllers: CheckFn = async () => {
  const diagnostics = summarizeDuplicateControllerDiagnostics();
  const topology = getCurrentControllerTopology();
  const blockedByOwner = topology.role === 'unknown' && topology.ownerPid !== undefined;

  if (diagnostics.warnings.length === 0 && !blockedByOwner) {
    return {
      id: 'duplicate-controllers',
      title: 'Duplicate OpenChrome controllers',
      status: 'ok',
      detail: `${diagnostics.processes.length} OpenChrome MCP process(es), no duplicate port/profile groups detected`,
    };
  }

  const duplicateDetail = diagnostics.duplicateGroups.map((group) => (
    `port ${group.port}, profile ${displayPath(group.userDataDir)}: pid(s) ${group.processes.map((proc) => proc.pid).join(', ')}`
  ));
  const ownershipDetail = blockedByOwner
    ? [`configured port ${topology.port}, profile ${displayPath(topology.userDataDir)} is already owned by OpenChrome PID ${topology.ownerPid}`]
    : [];
  const detailParts = [...diagnostics.warnings, ...duplicateDetail, ...ownershipDetail];

  return {
    id: 'duplicate-controllers',
    title: 'Duplicate OpenChrome controllers',
    status: 'warn',
    detail: detailParts.join('; '),
    remediation: diagnostics.remediation.join(' '),
    facts: {
      ...(blockedByOwner ? {
        runtime_topology: 'blocked-by-owner',
        port: topology.port,
        userDataDir: displayPath(topology.userDataDir),
        lockPath: displayPath(topology.lockPath),
        ownerPid: topology.ownerPid,
      } : {}),
    },
  };
};
