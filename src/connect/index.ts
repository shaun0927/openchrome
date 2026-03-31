/**
 * Connect module — web AI host connection guide.
 * Part of #523: Desktop App Web host connection guide.
 */

export type { WebAIHostId, HostDefinition, ConnectionInfo, ServerConnectionState } from './types';
export { HOST_DEFINITIONS, getHostDefinition, getHostIds } from './hosts';
export { generateConnectionInfo, generateAllConnectionInfo } from './config-generator';
