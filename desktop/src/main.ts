import { invoke } from "@tauri-apps/api/core";

interface ServerStatusResponse {
  status: "stopped" | "starting" | "running" | "error";
  port: number;
  error: string | null;
  uptime_secs: number | null;
}

const statusDot = document.getElementById("status-indicator")!;
const statusText = document.getElementById("status-text")!;
const btnToggle = document.getElementById("btn-toggle") as HTMLButtonElement;
const metricRam = document.getElementById("metric-ram")!;
const metricTabs = document.getElementById("metric-tabs")!;
const metricUptime = document.getElementById("metric-uptime")!;

let currentStatus: ServerStatusResponse["status"] = "stopped";

function updateStatusUI(resp: ServerStatusResponse) {
  currentStatus = resp.status;
  statusDot.className = "status-dot " + resp.status;

  const labels: Record<string, string> = {
    stopped: "Stopped",
    starting: "Starting...",
    running: `Running (port ${resp.port})`,
    error: `Error: ${resp.error || "Unknown"}`,
  };
  statusText.textContent = labels[resp.status] || resp.status;

  if (resp.status === "running") {
    btnToggle.textContent = "Stop";
    btnToggle.className = "btn btn-stop";
    btnToggle.disabled = false;
  } else if (resp.status === "starting") {
    btnToggle.textContent = "Starting...";
    btnToggle.className = "btn btn-start";
    btnToggle.disabled = true;
  } else {
    btnToggle.textContent = "Start Server";
    btnToggle.className = "btn btn-start";
    btnToggle.disabled = false;
  }

  if (resp.uptime_secs != null) {
    metricUptime.textContent = `Uptime: ${formatUptime(resp.uptime_secs)}`;
  } else {
    metricUptime.textContent = "Uptime: --";
  }
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function toggleServer() {
  try {
    if (currentStatus === "running") {
      btnToggle.disabled = true;
      const resp = await invoke<ServerStatusResponse>("stop_server");
      updateStatusUI(resp);
    } else if (currentStatus === "stopped" || currentStatus === "error") {
      btnToggle.disabled = true;
      statusDot.className = "status-dot starting";
      statusText.textContent = "Starting...";
      btnToggle.textContent = "Starting...";
      const resp = await invoke<ServerStatusResponse>("start_server", { port: 3100 });
      updateStatusUI(resp);
    }
  } catch (err) {
    console.error("Toggle server error:", err);
    statusText.textContent = `Error: ${err}`;
    statusDot.className = "status-dot stopped";
    btnToggle.textContent = "Start Server";
    btnToggle.className = "btn btn-start";
    btnToggle.disabled = false;
  }
}

async function pollStatus() {
  try {
    const resp = await invoke<ServerStatusResponse>("get_server_status");
    updateStatusUI(resp);
  } catch (err) {
    console.error("Poll status error:", err);
  }
}

btnToggle.addEventListener("click", toggleServer);
setInterval(pollStatus, 2000);
pollStatus();
