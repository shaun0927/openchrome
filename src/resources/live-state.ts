import type { MCPResourceDefinition } from './usage-guide';
import type { SessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';
import { getTaskJournal } from '../journal/task-journal';
import { getDashboardState } from '../desktop/dashboard-state';
import { RecordingStore } from '../recording/recording-store';
import { DEFAULT_TENANT_ID, type TenantId } from '../tenant/types';
import { currentRequestContext } from '../observability/request-id';

export const RESOURCE_FORBIDDEN_CODE = -32001;
export const RESOURCE_SUBSCRIPTION_LIMIT_CODE = -32002;

export class ResourceRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'ResourceRpcError';
  }
}

export interface MCPResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const LIVE_RESOURCE_TEMPLATES: MCPResourceTemplateDefinition[] = [
  {
    uriTemplate: 'oc://session/{sessionId}/tabs',
    name: 'openchrome-session-tabs',
    description: 'Current tab tree for one OpenChrome session; mirrors tabs_context structured data.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'oc://session/{sessionId}/state',
    name: 'openchrome-session-state',
    description: 'Lifecycle state and last-activity timestamp for one OpenChrome session.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'oc://journal/{taskId}',
    name: 'openchrome-task-journal',
    description: 'Latest 100 task journal entries for the task/session id.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'oc://recording/{recordingId}',
    name: 'openchrome-recording-status',
    description: 'Recording metadata/status and artifact path when available.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'oc://dashboard/state',
    name: 'openchrome-dashboard-state',
    description: 'Aggregate dashboard snapshot filtered to the caller tenant.',
    mimeType: 'application/json',
  },
];

export function liveResourceDefinitions(sessionManager: SessionManager): MCPResourceDefinition[] {
  const resources: MCPResourceDefinition[] = [
    {
      uri: 'oc://dashboard/state',
      name: 'openchrome-dashboard-state',
      description: 'Aggregate dashboard snapshot filtered to the caller tenant.',
      mimeType: 'application/json',
    },
  ];
  for (const session of sessionManager.getAllSessionInfos()) {
    resources.push({
      uri: sessionTabsUri(session.id),
      name: `openchrome-session-tabs-${session.id}`,
      description: `Current tab tree for session ${session.id}.`,
      mimeType: 'application/json',
    });
    resources.push({
      uri: sessionStateUri(session.id),
      name: `openchrome-session-state-${session.id}`,
      description: `Lifecycle state for session ${session.id}.`,
      mimeType: 'application/json',
    });
  }
  return resources;
}

export function sessionTabsUri(sessionId: string): string {
  return `oc://session/${encodeURIComponent(sessionId)}/tabs`;
}

export function sessionStateUri(sessionId: string): string {
  return `oc://session/${encodeURIComponent(sessionId)}/state`;
}

export function journalUri(taskId: string): string {
  return `oc://journal/${encodeURIComponent(taskId)}`;
}

export function recordingUri(recordingId: string): string {
  return `oc://recording/${encodeURIComponent(recordingId)}`;
}

export type LiveResourceKind = 'session-tabs' | 'session-state' | 'journal' | 'recording' | 'dashboard-state';

export interface ParsedLiveResourceUri {
  kind: LiveResourceKind;
  id?: string;
}

export function parseLiveResourceUri(uri: string): ParsedLiveResourceUri | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'oc:') return null;
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parsed.hostname === 'session' && parts.length === 2 && parts[1] === 'tabs') {
    return { kind: 'session-tabs', id: parts[0] };
  }
  if (parsed.hostname === 'session' && parts.length === 2 && parts[1] === 'state') {
    return { kind: 'session-state', id: parts[0] };
  }
  if (parsed.hostname === 'journal' && parts.length === 1) {
    return { kind: 'journal', id: parts[0] };
  }
  if (parsed.hostname === 'recording' && parts.length === 1) {
    return { kind: 'recording', id: parts[0] };
  }
  if (parsed.hostname === 'dashboard' && parts.length === 1 && parts[0] === 'state') {
    return { kind: 'dashboard-state' };
  }
  return null;
}

export function currentTenantId(): TenantId {
  return currentRequestContext()?.tenantId ?? DEFAULT_TENANT_ID;
}

export function assertSessionTenant(sessionManager: SessionManager, sessionId: string, tenantId = currentTenantId()): void {
  const session = sessionManager.getSession(sessionId);
  if (!session) return;
  const owner = session.tenantId ?? DEFAULT_TENANT_ID;
  if (owner !== tenantId) {
    throw new ResourceRpcError(RESOURCE_FORBIDDEN_CODE, 'Forbidden: tenant does not own requested session resource', { tenantId, sessionId });
  }
}

export function assertLiveResourceAccess(sessionManager: SessionManager, uri: string, tenantId = currentTenantId()): ParsedLiveResourceUri {
  const parsed = parseLiveResourceUri(uri);
  if (!parsed) {
    throw new Error(`Unknown resource: ${uri}`);
  }
  if ((parsed.kind === 'session-tabs' || parsed.kind === 'session-state' || parsed.kind === 'journal') && parsed.id) {
    assertSessionTenant(sessionManager, parsed.id, tenantId);
  }
  return parsed;
}

export async function readLiveResource(sessionManager: SessionManager, uri: string): Promise<{ mimeType: string; text: string }> {
  const parsed = assertLiveResourceAccess(sessionManager, uri);
  switch (parsed.kind) {
    case 'session-tabs':
      return json(await readSessionTabs(sessionManager, parsed.id!));
    case 'session-state':
      return json(readSessionState(sessionManager, parsed.id!));
    case 'journal':
      return json(readJournal(parsed.id!));
    case 'recording':
      return json(await readRecording(sessionManager, parsed.id!));
    case 'dashboard-state':
      return json(readDashboard(sessionManager));
    default:
      throw new Error(`No content handler for resource: ${uri}`);
  }
}

async function readSessionTabs(sessionManager: SessionManager, sessionId: string): Promise<Record<string, unknown>> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return { sessionId, defaultWorkerId: null, workerCount: 0, tabCount: 0, workers: [] };
  }
  const workers = sessionManager.getWorkers(sessionId);
  const workerPayloads = [];
  let tabCount = 0;
  for (const worker of workers) {
    const tabs = [];
    for (const targetId of sessionManager.getWorkerTargetIds(sessionId, worker.id)) {
      try {
        const page = await sessionManager.getPage(sessionId, targetId, worker.id, 'resources/read');
        if (!page) continue;
        tabs.push({
          tabId: targetId,
          workerId: worker.id,
          url: page.url(),
          title: await safeTitle(page),
          context: sessionManager.getTargetContextName(targetId),
        });
      } catch {
        // Target may have closed between listing and read.
      }
    }
    tabCount += tabs.length;
    workerPayloads.push({ id: worker.id, name: worker.name, tabCount: tabs.length, tabs });
  }
  return { sessionId, defaultWorkerId: session.defaultWorkerId, workerCount: workers.length, tabCount, workers: workerPayloads };
}

function readSessionState(sessionManager: SessionManager, sessionId: string): Record<string, unknown> {
  const info = sessionManager.getSessionInfo(sessionId);
  if (!info) {
    return { sessionId, lifecycle: 'idle', exists: false, lastActivityAt: null };
  }
  return {
    sessionId,
    lifecycle: info.targetCount > 0 ? 'active' : 'idle',
    exists: true,
    lastActivityAt: info.lastActivityAt,
    createdAt: info.createdAt,
    workerCount: info.workerCount,
    targetCount: info.targetCount,
  };
}

function readJournal(taskId: string): Record<string, unknown> {
  const entries = getTaskJournal().getRecent(1000)
    .filter((entry) => entry.sessionId === taskId)
    .slice(-100);
  return { taskId, entries, count: entries.length };
}

async function readRecording(sessionManager: SessionManager, recordingId: string): Promise<Record<string, unknown>> {
  const store = new RecordingStore();
  await store.init();
  const metadata = await store.readMetadata(recordingId);
  if (!metadata) {
    return { recordingId, status: 'not_found', artifactUrl: null };
  }
  assertSessionTenant(sessionManager, metadata.sessionId);
  const artifactUrl = metadata.stoppedAt ? `file://${store.getRecordingDir(recordingId)}` : null;
  return {
    recordingId,
    sessionId: metadata.sessionId,
    status: metadata.stoppedAt ? 'stopped' : 'active',
    artifactUrl,
    metadata,
  };
}

function readDashboard(sessionManager: SessionManager): Record<string, unknown> {
  const tenantId = currentTenantId();
  const visibleSessions = new Set(
    sessionManager.getAllSessionInfos()
      .filter((session) => (session.tenantId ?? DEFAULT_TENANT_ID) === tenantId)
      .map((session) => session.id),
  );
  const dashboard = getDashboardState();
  const calls = dashboard.getToolCalls(undefined, 100).filter((call) => visibleSessions.has(call.sessionId));
  return {
    uptimeSecs: dashboard.getUptimeSecs(),
    sessions: dashboard.getSessionSummaries().filter((session) => visibleSessions.has(session.sessionId)),
    recentToolCalls: calls,
  };
}

function json(value: unknown): { mimeType: string; text: string } {
  return { mimeType: 'application/json', text: JSON.stringify(value) };
}

export function parseResourceSubscriptionLimit(raw = process.env.OPENCHROME_RESOURCE_SUB_LIMIT): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.max(1, Math.min(1000, parsed));
}
