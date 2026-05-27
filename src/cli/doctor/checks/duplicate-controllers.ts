/**
 * Check: duplicate-controllers
 * Surfaces unsafe multi-controller OpenChrome topologies before they cause CDP disconnects.
 */

import type { CheckFn } from '../../doctor';
import { summarizeDuplicateControllerDiagnostics } from '../../../utils/duplicate-controller-diagnostics';

export const checkDuplicateControllers: CheckFn = async () => {
  const diagnostics = summarizeDuplicateControllerDiagnostics();
  if (diagnostics.warnings.length === 0) {
    return {
      id: 'duplicate-controllers',
      title: 'Duplicate OpenChrome controllers',
      status: 'ok',
      detail: `${diagnostics.processes.length} OpenChrome MCP process(es), no duplicate port/profile groups detected`,
    };
  }

  const duplicateDetail = diagnostics.duplicateGroups.map((group) => (
    `port ${group.port}, profile ${group.userDataDir}: pid(s) ${group.processes.map((proc) => proc.pid).join(', ')}`
  ));
  const detailParts = [...diagnostics.warnings, ...duplicateDetail];

  return {
    id: 'duplicate-controllers',
    title: 'Duplicate OpenChrome controllers',
    status: 'warn',
    detail: detailParts.join('; '),
    remediation: diagnostics.remediation.join(' '),
  };
};
