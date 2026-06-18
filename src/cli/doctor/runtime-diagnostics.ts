import * as os from 'os';
import { readBrokerMetadata } from '../../broker/discovery';
import { getCurrentControllerTopology } from '../../utils/duplicate-controller-diagnostics';
import { isPidAlive } from '../../utils/controller-lock';

export type ActiveRuntimePath =
  | 'direct-owner'
  | 'broker-owner'
  | 'broker-client'
  | 'auto-elect-owner'
  | 'auto-elect-client'
  | 'isolated-profile'
  | 'attach-mode'
  | 'unsafe-secondary-attach'
  | 'blocked-by-owner'
  | 'unknown';

export interface RuntimeDiagnostics {
  /** Derived controller/topology classification. */
  runtime_topology: ActiveRuntimePath;
  /** Compatibility alias for issue #1505 wording; prefer runtime_topology. */
  active_runtime_path: ActiveRuntimePath;
  facts: {
    port: number;
    userDataDir: string;
    controllerRole: string;
    lockPath: string;
    ownerPid?: number;
    brokerEndpoint?: string;
    brokerPid?: number;
    brokerPidAlive?: boolean;
    autoElectEnabled: boolean;
    unsafeSharedAttachEnabled: boolean;
    launchMode?: string;
  };
}

export interface DoctorDiagnostics {
  runtime: RuntimeDiagnostics;
}


export function displayPath(filePath: string): string {
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
    if (filePath.startsWith(`${home}/`)) return `~/${filePath.slice(home.length + 1)}`;
  }
  return filePath;
}

export function classifyRuntimePath(params: {
  controllerRole: string;
  ownerPid?: number;
  brokerPid?: number;
  brokerPidAlive?: boolean;
  autoElectEnabled?: boolean;
  unsafeSharedAttachEnabled?: boolean;
  launchMode?: string;
}): ActiveRuntimePath {
  if (params.unsafeSharedAttachEnabled || params.controllerRole === 'unsafe-secondary-attach') {
    return 'unsafe-secondary-attach';
  }
  if (params.launchMode === 'attach') return 'attach-mode';
  if (params.brokerPid && params.brokerPidAlive) {
    if (params.autoElectEnabled) {
      return params.ownerPid === params.brokerPid ? 'auto-elect-owner' : 'auto-elect-client';
    }
    return params.ownerPid === params.brokerPid ? 'broker-owner' : 'broker-client';
  }
  if (params.controllerRole === 'owner') return 'direct-owner';
  if (params.controllerRole === 'unknown' && params.ownerPid) return 'blocked-by-owner';
  if (params.launchMode === 'isolated') return 'isolated-profile';
  return 'unknown';
}

export function collectDoctorDiagnostics(): DoctorDiagnostics {
  const topology = getCurrentControllerTopology();
  const broker = readBrokerMetadata(topology.port, topology.userDataDir);
  const brokerPidAlive = broker?.pid !== undefined ? isPidAlive(broker.pid) : undefined;
  const autoElectEnabled = process.env.OPENCHROME_AUTO_ELECT === '1';
  const unsafeSharedAttachEnabled = process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH === '1';
  const launchMode = process.env.OPENCHROME_LAUNCH_MODE;

  const activeRuntimePath = classifyRuntimePath({
    controllerRole: topology.role,
    ownerPid: topology.ownerPid,
    brokerPid: broker?.pid,
    brokerPidAlive,
    autoElectEnabled,
    unsafeSharedAttachEnabled,
    launchMode,
  });

  return {
    runtime: {
      runtime_topology: activeRuntimePath,
      active_runtime_path: activeRuntimePath,
      facts: {
        port: topology.port,
        userDataDir: displayPath(topology.userDataDir),
        controllerRole: topology.role,
        lockPath: displayPath(topology.lockPath),
        ...(topology.ownerPid !== undefined ? { ownerPid: topology.ownerPid } : {}),
        ...(broker?.endpoint ? { brokerEndpoint: broker.endpoint } : {}),
        ...(broker?.pid !== undefined ? { brokerPid: broker.pid } : {}),
        ...(brokerPidAlive !== undefined ? { brokerPidAlive } : {}),
        autoElectEnabled,
        unsafeSharedAttachEnabled,
        ...(launchMode ? { launchMode } : {}),
      },
    },
  };
}
