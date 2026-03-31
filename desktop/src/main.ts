import { invoke } from "@tauri-apps/api/core";

interface ServerStatus {
  status: "stopped" | "starting" | "running" | "error";
  port: number;
  error: string | null;
  uptime_secs: number | null;
}

// DOM elements (from root index.html)
const btnToggle = document.getElementById("btn-toggle") as HTMLButtonElement;
const statusDot = document.getElementById("status-indicator")!;
const statusText = document.getElementById("status-text")!;
const metricUptime = document.getElementById("metric-uptime")!;
const mainPanel = document.getElementById("main-panel")!;

let currentStatus: ServerStatus["status"] = "stopped";

// Toggle server start/stop
btnToggle.addEventListener("click", async () => {
  btnToggle.disabled = true;

  try {
    if (currentStatus === "stopped" || currentStatus === "error") {
      updateUI({
        status: "starting",
        port: 3100,
        error: null,
        uptime_secs: null,
      });
      const result = await invoke<ServerStatus>("start_server", {
        port: 3100,
      });
      updateUI(result);
    } else if (currentStatus === "running") {
      const result = await invoke<ServerStatus>("stop_server");
      updateUI(result);
    }
  } catch (err) {
    updateUI({
      status: "error",
      port: 3100,
      error: String(err),
      uptime_secs: null,
    });
  }

  btnToggle.disabled = false;
});

function updateUI(status: ServerStatus): void {
  currentStatus = status.status;

  // Status dot
  statusDot.className = "status-dot " + status.status;

  // Status text
  const labels: Record<string, string> = {
    stopped: "Stopped",
    starting: "Starting...",
    running: `Running (port ${status.port})`,
    error: status.error || "Error",
  };
  statusText.textContent = labels[status.status] || status.status;

  // Button
  switch (status.status) {
    case "running":
      btnToggle.textContent = "Stop Server";
      btnToggle.className = "btn btn-stop";
      btnToggle.disabled = false;
      break;
    case "starting":
      btnToggle.textContent = "Starting...";
      btnToggle.className = "btn btn-start";
      btnToggle.disabled = true;
      break;
    default:
      btnToggle.textContent = "Start Server";
      btnToggle.className = "btn btn-start";
      btnToggle.disabled = false;
      break;
  }

  // Uptime metric
  if (status.uptime_secs != null) {
    metricUptime.textContent = `Uptime: ${formatUptime(status.uptime_secs)}`;
  } else {
    metricUptime.textContent = "Uptime: --";
  }

  // Main panel content
  if (status.status === "running") {
    mainPanel.innerHTML = `
      <div class="placeholder">
        <p>Server is running on port ${status.port}.<br>
        Connect from Claude, Cursor, or any MCP client.</p>
      </div>`;
  } else if (status.status === "error") {
    mainPanel.innerHTML = `
      <div class="placeholder">
        <p style="color: var(--danger);">${escapeHtml(status.error || "Unknown error")}</p>
      </div>`;
  } else {
    mainPanel.innerHTML = `
      <div class="placeholder">
        <p>Start the server and connect from Claude, Cursor, or any MCP client.</p>
      </div>`;
  }
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Poll server status every 2 seconds
async function pollStatus(): Promise<void> {
  try {
    const status = await invoke<ServerStatus>("get_server_status");
    updateUI(status);
  } catch {
    // Silently retry on next poll
  }
}

window.setInterval(pollStatus, 2000);
pollStatus();
