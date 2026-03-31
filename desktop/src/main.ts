import { invoke } from "@tauri-apps/api/core";

// --- Types ---

interface ServerStatus {
  status: "stopped" | "starting" | "running" | "error";
  port: number;
  error: string | null;
  uptime_secs: number | null;
  profile: string | null;
}

interface ChromeProfile {
  id: string;
  name: string;
}

interface AppSettings {
  selected_profile: string;
  port: number;
  auto_start: boolean;
}

// --- DOM ---

const btnToggle = document.getElementById("btn-toggle") as HTMLButtonElement;
const statusDot = document.getElementById("status-dot")!;
const statusText = document.getElementById("status-text")!;
const profileSelect = document.getElementById(
  "profile-select",
) as HTMLSelectElement;
const metricUptime = document.getElementById("metric-uptime")!;
const metricPort = document.getElementById("metric-port")!;

// --- State ---

let currentStatus: ServerStatus["status"] = "stopped";
let settings: AppSettings = { selected_profile: "", port: 3100, auto_start: false };

// --- Settings ---

async function loadSettings(): Promise<void> {
  try {
    settings = await invoke<AppSettings>("load_settings");
  } catch {
    // Use defaults
  }
}

async function saveSettings(): Promise<void> {
  try {
    await invoke("save_settings", { settingsData: settings });
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

// --- Profile Picker ---

async function loadProfiles(): Promise<void> {
  try {
    const profiles = await invoke<ChromeProfile[]>("get_chrome_profiles");
    profileSelect.innerHTML = "";

    if (profiles.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Default";
      profileSelect.appendChild(opt);
      return;
    }

    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      profileSelect.appendChild(opt);
    }

    // Restore saved selection
    if (settings.selected_profile && profiles.some((p) => p.id === settings.selected_profile)) {
      profileSelect.value = settings.selected_profile;
    }
  } catch {
    profileSelect.innerHTML = '<option value="">Default</option>';
  }
}

profileSelect.addEventListener("change", () => {
  settings.selected_profile = profileSelect.value;
  saveSettings();
});

// --- Server Toggle ---

btnToggle.addEventListener("click", async () => {
  btnToggle.disabled = true;

  try {
    if (currentStatus === "stopped" || currentStatus === "error") {
      updateUI({
        status: "starting",
        port: settings.port,
        error: null,
        uptime_secs: null,
        profile: null,
      });
      const profileDir = profileSelect.value || undefined;
      const result = await invoke<ServerStatus>("start_server", {
        port: settings.port,
        profileDirectory: profileDir,
      });
      updateUI(result);
    } else if (currentStatus === "running") {
      const result = await invoke<ServerStatus>("stop_server");
      updateUI(result);
    }
  } catch (err) {
    updateUI({
      status: "error",
      port: settings.port,
      error: String(err),
      uptime_secs: null,
      profile: null,
    });
  }

  btnToggle.disabled = false;
});

// --- UI Update ---

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
      profileSelect.disabled = true;
      break;
    case "starting":
      btnToggle.textContent = "Starting...";
      btnToggle.className = "btn btn-start";
      btnToggle.disabled = true;
      profileSelect.disabled = true;
      break;
    default:
      btnToggle.textContent = "Start Server";
      btnToggle.className = "btn btn-start";
      btnToggle.disabled = false;
      profileSelect.disabled = false;
      break;
  }

  // Metrics
  metricPort.textContent = "Port: " + status.port;
  if (status.uptime_secs != null) {
    metricUptime.textContent = "Uptime: " + formatUptime(status.uptime_secs);
  } else {
    metricUptime.textContent = "Uptime: --";
  }
}

function formatUptime(secs: number): string {
  if (secs < 60) return secs + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m " + (secs % 60) + "s";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h + "h " + m + "m";
}

// --- Status Polling ---

async function pollStatus(): Promise<void> {
  try {
    const status = await invoke<ServerStatus>("get_server_status");
    updateUI(status);
  } catch {
    // Silently retry on next poll
  }
}

// --- Init ---

async function init(): Promise<void> {
  await loadSettings();
  await loadProfiles();
  pollStatus();

  // Auto-start if configured
  if (settings.auto_start) {
    btnToggle.click();
  }
}

init();
window.setInterval(pollStatus, 2000);
