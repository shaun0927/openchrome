import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getVersion } from '../version';
import { controllerLockKey, normalizeControllerUserDataDir } from '../utils/controller-lock';

export interface BrokerIdentity {
  port: number;
  userDataDir: string;
  httpHost: string;
  httpPort: number;
  pid?: number;
  startedAt?: string;
  version?: string;
  authTokenEnv?: string;
}

export interface BrokerMetadata {
  schemaVersion: 1;
  pid: number;
  version: string;
  startedAt: string;
  port: number;
  userDataDir: string;
  endpoint: string;
  authTokenEnv?: string;
}

export function getBrokerRegistryDir(rootDir = process.env.OPENCHROME_BROKER_REGISTRY_DIR): string {
  return rootDir || path.join(os.homedir(), '.openchrome', 'brokers');
}

export function getBrokerMetadataPath(port: number, userDataDir: string, rootDir?: string): string {
  return path.join(getBrokerRegistryDir(rootDir), `${controllerLockKey(port, userDataDir)}.json`);
}

function normalizeHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

export function buildBrokerMetadata(identity: BrokerIdentity): BrokerMetadata {
  const userDataDir = normalizeControllerUserDataDir(identity.userDataDir);
  return {
    schemaVersion: 1,
    pid: identity.pid ?? process.pid,
    version: identity.version ?? getVersion(),
    startedAt: identity.startedAt ?? new Date().toISOString(),
    port: identity.port,
    userDataDir,
    endpoint: `http://${normalizeHost(identity.httpHost)}:${identity.httpPort}/mcp`,
    ...(identity.authTokenEnv ? { authTokenEnv: identity.authTokenEnv } : {}),
  };
}

export function publishBrokerMetadata(identity: BrokerIdentity, rootDir?: string): BrokerMetadata {
  const metadata = buildBrokerMetadata(identity);
  const filePath = getBrokerMetadataPath(identity.port, metadata.userDataDir, rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  return metadata;
}

export function readBrokerMetadata(port: number, userDataDir: string, rootDir?: string): BrokerMetadata | null {
  const filePath = getBrokerMetadataPath(port, userDataDir, rootDir);
  try {
    const metadata = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BrokerMetadata;
    if (metadata.schemaVersion !== 1 || typeof metadata.endpoint !== 'string' || typeof metadata.pid !== 'number') return null;
    return metadata;
  } catch {
    return null;
  }
}

export function removeBrokerMetadata(port: number, userDataDir: string, pid = process.pid, rootDir?: string): void {
  const filePath = getBrokerMetadataPath(port, userDataDir, rootDir);
  const existing = readBrokerMetadata(port, userDataDir, rootDir);
  if (existing && existing.pid !== pid) return;
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}
