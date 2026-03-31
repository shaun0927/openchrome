import { invoke } from "@tauri-apps/api/core";

// --- Types ---

interface ServerStatus {
  status: "stopped" | "starting" | "running" | "error";
  port: number;
  error: string | null;
  uptime_secs: number | null;
}

interface Session {
  id: string;
  worker_count: number;
  tab_count: number;
  created_at: number;
  last_activity: number;
}

interface ToolCall {
  id: string;
  tool_name: string;
  session_id: string;
  args_summary: string;
  status: "running" | "success" | "error";
  start_time: number;
  end_time: number | null;
  duration_ms: number | null;
  error: string | null;
}

interface Metrics {
  ram_mb: number;
  tab_count: number;
  uptime_secs: number;
  session_count: number;
}

// --- DOM ---

const statusDot = document.getElementById("status-dot")!;
const statusLabel = document.getElementById("status-label")!;
const btnToggle = document.getElementById("btn-toggle") as HTMLButtonElement;
const connectionList = document.getElementById("connection-list")!;
const emptyConnections = document.getElementById("empty-connections")!;
const screenshotPanel = document.getElementById("screenshot-panel")!;
const screenshotPlaceholder = document.getElementById(
  "screenshot-placeholder",
)!;
const screenshotImg = document.getElementById(
  "screenshot-img",
) as HTMLImageElement;
const screenshotMeta = document.getElementById("screenshot-meta")!;
const screenshotTitle = document.getElementById("screenshot-title")!;
const screenshotAge = document.getElementById("screenshot-age")!;
const toolFeedList = document.getElementById("tool-feed-list")!;
const metricRam = document.getElementById("metric-ram")!;
const metricTabs = document.getElementById("metric-tabs")!;
const metricUptime = document.getElementById("metric-uptime")!;

// --- State ---

let currentStatus: ServerStatus["status"] = "stopped";
let selectedSessionId: string | null = null;
let lastScreenshotTime = 0;
let screenshotTimer: ReturnType<typeof setInterval> | null = null;
let toolCallTimer: ReturnType<typeof setInterval> | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;

// --- Server Control ---

btnToggle.addEventListener("click", async () => {
  btnToggle.disabled = true;
  try {
    if (currentStatus === "running") {
      const resp = await invoke<ServerStatus>("stop_server");
      updateServerStatus(resp);
    } else if (currentStatus === "stopped" || currentStatus === "error") {
      updateServerStatus({
        status: "starting",
        port: 3100,
        error: null,
        uptime_secs: null,
      });
      const resp = await invoke<ServerStatus>("start_server", { port: 3100 });
      updateServerStatus(resp);
    }
  } catch (err) {
    updateServerStatus({
      status: "error",
      port: 3100,
      error: String(err),
      uptime_secs: null,
    });
  }
  btnToggle.disabled = false;
});

function updateServerStatus(resp: ServerStatus): void {
  currentStatus = resp.status;

  statusDot.className = "status-dot " + resp.status;

  const labels: Record<string, string> = {
    stopped: "Stopped",
    starting: "Starting...",
    running: `Running (port ${resp.port})`,
    error: resp.error || "Error",
  };
  statusLabel.textContent = labels[resp.status] || resp.status;

  if (resp.status === "running") {
    btnToggle.textContent = "Stop";
    btnToggle.className = "btn btn-stop";
    btnToggle.disabled = false;
    startDashboardPolling();
  } else if (resp.status === "starting") {
    btnToggle.textContent = "Starting...";
    btnToggle.className = "btn btn-start";
    btnToggle.disabled = true;
  } else {
    btnToggle.textContent = "Start Server";
    btnToggle.className = "btn btn-start";
    btnToggle.disabled = false;
    stopDashboardPolling();
    clearDashboard();
  }
  updateConnectView();
}

// --- Dashboard Polling ---

function startDashboardPolling(): void {
  stopDashboardPolling();
  pollSessions();
  pollToolCalls();
  pollMetrics();
  pollScreenshot();

  screenshotTimer = setInterval(pollScreenshot, 1500);
  toolCallTimer = setInterval(pollToolCalls, 1000);
  metricsTimer = setInterval(pollMetrics, 5000);
  // Sessions polled less frequently
  setInterval(pollSessions, 3000);
}

function stopDashboardPolling(): void {
  if (screenshotTimer) clearInterval(screenshotTimer);
  if (toolCallTimer) clearInterval(toolCallTimer);
  if (metricsTimer) clearInterval(metricsTimer);
  screenshotTimer = null;
  toolCallTimer = null;
  metricsTimer = null;
}

function clearDashboard(): void {
  connectionList.innerHTML = "";
  emptyConnections.hidden = false;
  connectionList.appendChild(emptyConnections);
  screenshotImg.hidden = true;
  screenshotPlaceholder.hidden = false;
  screenshotMeta.hidden = true;
  toolFeedList.innerHTML = '<div class="empty-state">No tool calls yet</div>';
  metricRam.textContent = "RAM: --";
  metricTabs.textContent = "Chrome: 0 tabs";
  metricUptime.textContent = "Uptime: --";
  selectedSessionId = null;
}

// --- Sessions ---

async function pollSessions(): Promise<void> {
  try {
    const data = await invoke<{ sessions: Session[] }>("get_sessions");
    renderSessions(data.sessions || []);
  } catch {
    // Retry on next poll
  }
}

function renderSessions(sessions: Session[]): void {
  if (sessions.length === 0) {
    connectionList.innerHTML = "";
    emptyConnections.hidden = false;
    connectionList.appendChild(emptyConnections);
    if (selectedSessionId) {
      selectedSessionId = null;
      screenshotImg.hidden = true;
      screenshotPlaceholder.hidden = false;
      screenshotPlaceholder.innerHTML = "<p>Select a connection to view</p>";
    }
    return;
  }

  emptyConnections.hidden = true;
  connectionList.innerHTML = "";

  // Auto-select first session if none selected
  if (
    !selectedSessionId ||
    !sessions.find((s) => s.id === selectedSessionId)
  ) {
    selectedSessionId = sessions[0].id;
  }

  for (const s of sessions) {
    const el = document.createElement("div");
    el.className =
      "connection-item" + (s.id === selectedSessionId ? " selected" : "");
    el.innerHTML = `
      <div class="connection-dot"></div>
      <div class="connection-info">
        <div class="connection-name">${escapeHtml(s.id)}</div>
        <div class="connection-detail">${s.tab_count} tab${s.tab_count !== 1 ? "s" : ""}</div>
      </div>`;
    el.addEventListener("click", () => {
      selectedSessionId = s.id;
      renderSessions(sessions);
      pollScreenshot();
    });
    connectionList.appendChild(el);
  }
}

// --- Screenshot Stream ---

async function pollScreenshot(): Promise<void> {
  if (!selectedSessionId || currentStatus !== "running") return;

  try {
    const data = await invoke<{ data: string; title?: string }>(
      "capture_screenshot",
      { sessionId: selectedSessionId },
    );

    if (data && data.data) {
      screenshotImg.src = "data:image/webp;base64," + data.data;
      screenshotImg.hidden = false;
      screenshotPlaceholder.hidden = true;
      screenshotMeta.hidden = false;
      screenshotTitle.textContent = data.title || "";
      lastScreenshotTime = Date.now();
      updateScreenshotAge();
    }
  } catch {
    // No screenshot available
  }
}

function updateScreenshotAge(): void {
  if (lastScreenshotTime === 0) return;
  const ago = Math.round((Date.now() - lastScreenshotTime) / 1000);
  screenshotAge.textContent = `${ago}s ago`;
}

// Update age counter every second
setInterval(updateScreenshotAge, 1000);

// --- Tool Call Feed ---

async function pollToolCalls(): Promise<void> {
  try {
    const data = await invoke<{ tool_calls: ToolCall[] }>("get_tool_calls", {
      sessionId: selectedSessionId,
      limit: 20,
    });
    renderToolCalls(data.tool_calls || []);
  } catch {
    // Retry on next poll
  }
}

function renderToolCalls(calls: ToolCall[]): void {
  if (calls.length === 0) {
    toolFeedList.innerHTML = '<div class="empty-state">No tool calls yet</div>';
    return;
  }

  toolFeedList.innerHTML = "";

  for (const c of calls) {
    const el = document.createElement("div");
    el.className = "tool-item";

    let icon = "";
    let iconClass = "";
    if (c.status === "success") {
      icon = "\u2705";
      iconClass = "success";
    } else if (c.status === "error") {
      icon = "\u274C";
      iconClass = "error";
    } else {
      icon = "\u23F3";
      iconClass = "running";
    }

    const duration =
      c.duration_ms != null ? `${(c.duration_ms / 1000).toFixed(1)}s` : "";

    const argsSummary = c.args_summary
      ? ` \u2192 ${escapeHtml(c.args_summary)}`
      : "";

    el.innerHTML = `
      <span class="tool-icon ${iconClass}">${icon}</span>
      <span class="tool-name">${escapeHtml(c.tool_name)}</span>
      <span class="tool-args">${argsSummary}</span>
      <span class="tool-duration">${duration}</span>`;

    toolFeedList.appendChild(el);
  }
}

// --- Metrics ---

async function pollMetrics(): Promise<void> {
  try {
    const data = await invoke<Metrics>("get_metrics");
    if (data) {
      metricRam.textContent = `RAM: ${data.ram_mb}MB`;
      metricTabs.textContent = `Chrome: ${data.tab_count} tab${data.tab_count !== 1 ? "s" : ""}`;
      metricUptime.textContent = `Uptime: ${formatUptime(data.uptime_secs)}`;
    }
  } catch {
    // Retry on next poll
  }
}

// --- Helpers ---

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// --- Tab Navigation ---

const viewDashboard = document.getElementById("view-dashboard")!;
const viewConnect = document.getElementById("view-connect")!;
const tabDashboard = document.getElementById("tab-dashboard")!;
const tabConnect = document.getElementById("tab-connect")!;

function switchTab(tab: "dashboard" | "connect"): void {
  viewDashboard.hidden = tab !== "dashboard";
  viewConnect.hidden = tab !== "connect";
  tabDashboard.classList.toggle("active", tab === "dashboard");
  tabConnect.classList.toggle("active", tab === "connect");
}

tabDashboard.addEventListener("click", () => switchTab("dashboard"));
tabConnect.addEventListener("click", () => switchTab("connect"));

// --- Connect View ---

interface HostDefinition {
  id: string;
  name: string;
  settingsUrl: string | null;
  steps: string[];
  notes: string[];
}

const HOST_DEFS: Record<string, HostDefinition> = {
  claude: {
    id: "claude",
    name: "Claude Web",
    settingsUrl: "https://claude.ai/customize/connectors?modal=add-custom-connector",
    steps: [
      'Click "Open Settings Page" below',
      "Paste the server URL into the URL field",
      "Click Save — you're ready to chat!",
    ],
    notes: [
      "OAuth fields can be left empty — authentication uses the Bearer token.",
    ],
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    settingsUrl: "https://chatgpt.com/gpts/mine",
    steps: [
      'Click "Open Settings Page" below',
      "Create or edit an app, then paste the server URL",
      "Save and start a conversation with your app",
    ],
    notes: [
      "You may need to enable Developer Mode in ChatGPT settings.",
    ],
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    settingsUrl: "https://aistudio.google.com/app/mcpserver",
    steps: [
      'Click "Open Settings Page" below',
      "Add a custom MCP server and paste the server URL",
      "Complete any additional Google Cloud setup if prompted",
    ],
    notes: [
      "Gemini MCP support may require a Google Cloud project.",
    ],
  },
  custom: {
    id: "custom",
    name: "Other / Custom",
    settingsUrl: null,
    steps: [
      "Copy the server URL and Bearer token",
      "Paste into your MCP client's server configuration",
      "Start using OpenChrome tools in your client",
    ],
    notes: [
      "Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.",
    ],
  },
};

let selectedHost = "claude";

const platformSelector = document.getElementById("platform-selector")!;
const connectUrl = document.getElementById("connect-url")!;
const btnCopyUrl = document.getElementById("btn-copy-url")!;
const connectToken = document.getElementById("connect-token")!;
const btnCopyToken = document.getElementById("btn-copy-token")!;
const connectTokenSection = document.getElementById("connect-token-section")!;
const connectSettingsSection = document.getElementById("connect-settings-section")!;
const btnOpenSettings = document.getElementById("btn-open-settings")!;
const connectSteps = document.getElementById("connect-steps")!;
const connectNotes = document.getElementById("connect-notes")!;
const connectNotesSection = document.getElementById("connect-notes-section")!;

platformSelector.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest("[data-host]") as HTMLElement | null;
  if (!target) return;
  selectedHost = target.dataset.host!;
  platformSelector.querySelectorAll(".platform-btn").forEach((btn) => {
    btn.classList.toggle("selected", (btn as HTMLElement).dataset.host === selectedHost);
  });
  updateConnectView();
});

function updateConnectView(): void {
  const host = HOST_DEFS[selectedHost];
  if (!host) return;

  // URL
  const port = 3100;
  if (currentStatus === "running") {
    const url = `http://localhost:${port}/mcp`;
    connectUrl.textContent = url;
    connectUrl.classList.remove("no-server");
  } else {
    connectUrl.textContent = "Server not running — start it first";
    connectUrl.classList.add("no-server");
  }

  // Token placeholder (shown when tunnel active in future)
  connectTokenSection.hidden = true;

  // Settings button
  if (host.settingsUrl) {
    connectSettingsSection.hidden = false;
    btnOpenSettings.textContent = `Open ${host.name} Settings`;
  } else {
    connectSettingsSection.hidden = true;
  }

  // Steps
  connectSteps.innerHTML = "";
  for (const step of host.steps) {
    const li = document.createElement("li");
    li.textContent = step;
    connectSteps.appendChild(li);
  }

  // Notes
  if (host.notes.length > 0) {
    connectNotesSection.hidden = false;
    connectNotes.innerHTML = "";
    for (const note of host.notes) {
      const li = document.createElement("li");
      li.textContent = note;
      connectNotes.appendChild(li);
    }
  } else {
    connectNotesSection.hidden = true;
  }
}

btnCopyUrl.addEventListener("click", async () => {
  const text = connectUrl.textContent || "";
  if (text && !text.startsWith("Server not")) {
    await navigator.clipboard.writeText(text);
    btnCopyUrl.textContent = "✓";
    btnCopyUrl.classList.add("copied");
    setTimeout(() => {
      btnCopyUrl.textContent = "📋";
      btnCopyUrl.classList.remove("copied");
    }, 1500);
  }
});

btnCopyToken.addEventListener("click", async () => {
  const text = connectToken.dataset.fullToken || "";
  if (text) {
    await navigator.clipboard.writeText(text);
    btnCopyToken.textContent = "✓";
    btnCopyToken.classList.add("copied");
    setTimeout(() => {
      btnCopyToken.textContent = "📋";
      btnCopyToken.classList.remove("copied");
    }, 1500);
  }
});

btnOpenSettings.addEventListener("click", () => {
  const host = HOST_DEFS[selectedHost];
  if (host?.settingsUrl) {
    window.open(host.settingsUrl, "_blank");
  }
});

// Initialize connect view
updateConnectView();

// --- Status Polling ---

async function pollStatus(): Promise<void> {
  try {
    const resp = await invoke<ServerStatus>("get_server_status");
    updateServerStatus(resp);
  } catch {
    // Retry on next poll
  }
}

// --- Init ---

setInterval(pollStatus, 2000);
pollStatus();
