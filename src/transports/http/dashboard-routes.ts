import type * as http from 'node:http';
import { getDashboardState } from '../../desktop/dashboard-state';
import { authorizeDashboardEndpoint, canSeeTenant } from '../../middleware/dashboard-authz';
import { logAuditEntry } from '../../security/audit-logger';
import type { SessionManager } from '../../session-manager';
import { renderPrometheusMetrics, type PrometheusMetric } from '../prometheus';

type DashboardEndpoint = 'screenshot' | 'sessions' | 'tool-calls' | 'metrics';

function writeDashboardAuthzFailure(
  res: http.ServerResponse,
  endpoint: DashboardEndpoint,
  sessionId: string,
  status: 401 | 403,
  error: string,
): void {
  // Audit denial so that probing of cross-tenant resources is observable in
  // the same place that auth_failure entries already live.
  try {
    logAuditEntry('dashboard_authz_failure', sessionId, { endpoint, status }, undefined, { status: 'error' });
  } catch {
    // best-effort
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

async function captureScreenshot(
  sessionManager: SessionManager,
  sessionId: string,
): Promise<{ base64: string; format: string; sessionId: string }> {
  const infos = sessionManager.getAllSessionInfos();
  const sessionInfo = infos.find((s) => s.id === sessionId);

  if (!sessionInfo || sessionInfo.targetCount === 0) {
    throw new Error(`No tabs found for session "${sessionId}"`);
  }

  // Get the first worker's first target as the "active" page
  const cdpClient = sessionManager.getCDPClient();
  let targetId: string | undefined;

  for (const worker of sessionInfo.workers) {
    const workerData = sessionManager.getWorker(sessionId, worker.id);
    if (workerData && workerData.targets.size > 0) {
      // Get the most recently added target (last in insertion order)
      for (const tid of workerData.targets) {
        targetId = tid;
      }
      break;
    }
  }

  if (!targetId) {
    throw new Error(`No active target found for session "${sessionId}"`);
  }

  const page = await cdpClient.getPageByTargetId(targetId);
  if (!page || page.isClosed()) {
    throw new Error(`Page for target ${targetId} is closed or unavailable`);
  }

  const cdpSession = await page.createCDPSession();
  try {
    const result = await cdpSession.send('Page.captureScreenshot', {
      format: 'webp',
      quality: 60,
    }) as { data: string };
    return { base64: result.data, format: 'webp', sessionId };
  } finally {
    await cdpSession.detach().catch(() => { /* ignore */ });
  }
}

export function handleDashboardScreenshot(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
  sessionManager: SessionManager | null,
): void {
  const requestedSessionId = url.searchParams.get('session_id') || url.searchParams.get('sessionId');
  const sessionId = requestedSessionId || 'default';

  if (!sessionManager) {
    const authz = authorizeDashboardEndpoint(req, 'screenshot');
    if (!authz.ok) {
      writeDashboardAuthzFailure(res, 'screenshot', sessionId, authz.status, authz.error);
      return;
    }
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session manager not available' }));
    return;
  }

  // Always look up the resolved session — including the implicit "default" —
  // so that a tenant-scoped caller cannot read another tenant's default
  // session screenshot just by omitting `session_id`.
  const session = sessionManager.getSession(sessionId);
  const authz = authorizeDashboardEndpoint(req, 'screenshot', {
    requireSessionOwnership: true,
    requestedSessionTenantId: session?.tenantId,
  });
  if (!authz.ok) {
    writeDashboardAuthzFailure(res, 'screenshot', sessionId, authz.status, authz.error);
    return;
  }

  captureScreenshot(sessionManager, sessionId)
    .then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    })
    .catch((err) => {
      console.error('[HTTPTransport] Screenshot error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Screenshot failed' }));
    });
}

export function handleDashboardSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionManager: SessionManager | null,
): void {
  const authz = authorizeDashboardEndpoint(req, 'sessions');
  if (!authz.ok) {
    writeDashboardAuthzFailure(res, 'sessions', 'anonymous', authz.status, authz.error);
    return;
  }

  if (!sessionManager) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  const infos = sessionManager.getAllSessionInfos()
    .filter((info) => canSeeTenant(authz.principal, info.tenantId));
  const sessions = infos.map((info) => ({
    id: info.id,
    name: info.name,
    tabCount: info.targetCount,
    workerCount: info.workerCount,
    createdAt: info.createdAt,
    lastActivityAt: info.lastActivityAt,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sessions }));
}

export function handleDashboardToolCalls(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
  sessionManager: SessionManager | null,
): void {
  const sessionId = url.searchParams.get('session_id') || undefined;
  const requestedSession = sessionId && sessionManager
    ? sessionManager.getSession(sessionId)
    : undefined;

  const authz = authorizeDashboardEndpoint(req, 'tool-calls', {
    requireSessionOwnership: sessionId !== undefined,
    requestedSessionTenantId: requestedSession?.tenantId,
  });
  if (!authz.ok) {
    writeDashboardAuthzFailure(res, 'tool-calls', sessionId ?? 'anonymous', authz.status, authz.error);
    return;
  }

  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const clampedLimit = Math.min(Math.max(1, limit), 100);

  const dashboardState = getDashboardState();
  let calls = dashboardState.getToolCalls(sessionId, clampedLimit);

  // Tenant-scoped admins must not see tool calls from other tenants. When the
  // session has been deleted we cannot prove ownership, so the call is hidden.
  if (sessionManager) {
    calls = calls.filter((c) => canSeeTenant(authz.principal, sessionManager.getSession(c.sessionId)?.tenantId));
  } else if (!canSeeTenant(authz.principal, undefined)) {
    calls = [];
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ calls }));
}

export function handleDashboardMetrics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionManager: SessionManager | null,
): void {
  const authz = authorizeDashboardEndpoint(req, 'metrics');
  if (!authz.ok) {
    writeDashboardAuthzFailure(res, 'metrics', 'anonymous', authz.status, authz.error);
    return;
  }

  const mem = process.memoryUsage();
  const dashboardState = getDashboardState();

  let tabCount = 0;
  let sessionCount = 0;
  if (sessionManager) {
    // Tenant-scoped principals must only see counts for their own tenant —
    // the global getStats() exposes activity from every tenant.
    const visible = sessionManager.getAllSessionInfos()
      .filter((info) => canSeeTenant(authz.principal, info.tenantId));
    sessionCount = visible.length;
    for (const info of visible) {
      tabCount += info.targetCount;
    }
  }

  const metrics = {
    ram_mb: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
    tab_count: tabCount,
    uptime_secs: dashboardState.getUptimeSecs(),
    session_count: sessionCount,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(metrics));
}

export function handleDashboardPrometheusMetrics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionManager: SessionManager | null,
): void {
  const authz = authorizeDashboardEndpoint(req, 'metrics');
  if (!authz.ok) {
    writeDashboardAuthzFailure(res, 'metrics', 'anonymous', authz.status, authz.error);
    return;
  }

  const mem = process.memoryUsage();
  const dashboardState = getDashboardState();

  let tabCount = 0;
  let sessionCount = 0;
  const toolCallCounts: Record<string, { success: number; error: number }> = {};
  if (sessionManager) {
    const visible = sessionManager.getAllSessionInfos()
      .filter((info) => canSeeTenant(authz.principal, info.tenantId));
    sessionCount = visible.length;
    for (const info of visible) {
      tabCount += info.targetCount;
    }
  }

  for (const row of dashboardState.getToolCallTotals()) {
    if (!row.toolName) continue;
    if (sessionManager) {
      const sessionTenantId = sessionManager.getSession(row.sessionId)?.tenantId;
      if (!canSeeTenant(authz.principal, sessionTenantId)) continue;
    } else if (!canSeeTenant(authz.principal, undefined)) {
      continue;
    }
    const slot = toolCallCounts[row.toolName] ?? { success: 0, error: 0 };
    slot[row.result] += row.count;
    toolCallCounts[row.toolName] = slot;
  }

  let activeCount = 0;
  for (const call of dashboardState.getToolCalls(undefined, 1000)) {
    if (call.status !== 'running') continue;
    if (sessionManager) {
      const sessionTenantId = sessionManager.getSession(call.sessionId)?.tenantId;
      if (!canSeeTenant(authz.principal, sessionTenantId)) continue;
    } else if (!canSeeTenant(authz.principal, undefined)) {
      continue;
    }
    activeCount++;
  }

  const toolCallSamples: Array<{ labels: Record<string, string>; value: number }> = [];
  for (const [tool, counts] of Object.entries(toolCallCounts)) {
    if (counts.success > 0) {
      toolCallSamples.push({ labels: { tool, result: 'success' }, value: counts.success });
    }
    if (counts.error > 0) {
      toolCallSamples.push({ labels: { tool, result: 'error' }, value: counts.error });
    }
  }

  const metrics: PrometheusMetric[] = [
    {
      name: 'openchrome_uptime_seconds',
      help: 'Server uptime in seconds since process start.',
      type: 'gauge',
      value: dashboardState.getUptimeSecs(),
    },
    {
      name: 'openchrome_ram_bytes',
      help: 'Resident set size (RSS) of the openchrome server process.',
      type: 'gauge',
      value: mem.rss,
    },
    {
      name: 'openchrome_tab_count',
      help: 'Number of Chrome tabs currently tracked across visible sessions.',
      type: 'gauge',
      value: tabCount,
    },
    {
      name: 'openchrome_session_count',
      help: 'Number of active MCP sessions visible to the requesting principal.',
      type: 'gauge',
      value: sessionCount,
    },
    {
      name: 'openchrome_tool_calls_total',
      help: 'Cumulative tool call count, labelled by tool name and result.',
      type: 'counter',
      samples: toolCallSamples,
    },
    {
      name: 'openchrome_tool_calls_active',
      help: 'Tool calls currently in flight (status="running" in the dashboard ring).',
      type: 'gauge',
      value: activeCount,
    },
  ];

  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  });
  res.end(renderPrometheusMetrics(metrics));
}
