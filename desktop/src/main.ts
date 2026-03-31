import { invoke } from "@tauri-apps/api/core";

interface ServerStatus {
  status: "stopped" | "starting" | "running" | "error";
  port: number;
  error: string | null;
  uptime_secs: number | null;
  profile: string | null;
}
interface ChromeProfile { id: string; name: string; }
interface AppSettings { selected_profile: string; port: number; auto_start: boolean; }

const btnToggle = document.getElementById("btn-toggle") as HTMLButtonElement;
const btnIcon = document.getElementById("btn-icon")!;
const btnLabel = document.getElementById("btn-label")!;
const statusDot = document.getElementById("status-dot")!;
const statusText = document.getElementById("status-text")!;
const statusMeta = document.getElementById("status-meta")!;
const profileSelect = document.getElementById("profile-select") as HTMLSelectElement;
const profileHint = document.getElementById("profile-hint")!;
const metricUptime = document.getElementById("metric-uptime")!;
const metricPort = document.getElementById("metric-port")!;
const errorBanner = document.getElementById("error-banner")!;
const errorText = document.getElementById("error-text")!;
const errorDismiss = document.getElementById("error-dismiss")!;

let currentStatus: ServerStatus["status"] = "stopped";
let runningProfile: string | null = null;
let settings: AppSettings = { selected_profile: "", port: 3100, auto_start: false };

// --- Error handling ---
function showError(msg: string): void {
  errorText.textContent = friendlyError(msg);
  errorBanner.hidden = false;
}
function hideError(): void { errorBanner.hidden = true; }
errorDismiss.addEventListener("click", hideError);

function friendlyError(msg: string): string {
  if (msg.includes("EADDRINUSE") || (msg.includes("port") && msg.includes("in use")))
    return "Port is already in use. Try closing other servers or changing the port.";
  if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("No such file"))
    return "Chrome isn't installed or couldn't be found on this computer.";
  if (msg.includes("timed out") || msg.includes("timeout"))
    return "Server took too long to start. Please try again.";
  if (msg.includes("Failed to spawn"))
    return "Couldn't start the server. Make sure Chrome is installed.";
  if (msg.includes("Failed to create sidecar"))
    return "Server files are missing. Please reinstall the app.";
  return msg.replace(/^(Error: |error: )/, "");
}

// --- Settings ---
async function loadSettings(): Promise<void> {
  try { settings = await invoke<AppSettings>("load_settings"); } catch { /* defaults */ }
}
async function saveSettings(): Promise<void> {
  try { await invoke("save_settings", { settingsData: settings }); } catch { /* silent */ }
}

// --- Profile Picker ---
async function loadProfiles(): Promise<void> {
  try {
    const profiles = await invoke<ChromeProfile[]>("get_chrome_profiles");
    profileSelect.innerHTML = "";
    if (profiles.length === 0) {
      profileSelect.innerHTML = '<option value="">Default</option>';
      return;
    }
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      profileSelect.appendChild(opt);
    }
    if (settings.selected_profile && profiles.some((p) => p.id === settings.selected_profile))
      profileSelect.value = settings.selected_profile;
  } catch {
    profileSelect.innerHTML = '<option value="">Default</option>';
  }
}

profileSelect.addEventListener("change", () => {
  settings.selected_profile = profileSelect.value;
  saveSettings();
  if (currentStatus === "running" && runningProfile !== profileSelect.value) {
    profileHint.textContent = "Restart the server to use this profile.";
    profileHint.hidden = false;
  } else {
    profileHint.hidden = true;
  }
});

// --- Server Toggle ---
btnToggle.addEventListener("click", async () => {
  btnToggle.disabled = true;
  hideError();
  try {
    if (currentStatus === "stopped" || currentStatus === "error") {
      updateUI({ status: "starting", port: settings.port, error: null, uptime_secs: null, profile: null });
      const profileDir = profileSelect.value || undefined;
      const result = await invoke<ServerStatus>("start_server", { port: settings.port, profileDirectory: profileDir });
      runningProfile = profileDir || null;
      profileHint.hidden = true;
      updateUI(result);
    } else if (currentStatus === "running") {
      const result = await invoke<ServerStatus>("stop_server");
      runningProfile = null;
      profileHint.hidden = true;
      updateUI(result);
    }
  } catch (err) {
    showError(String(err));
    updateUI({ status: "error", port: settings.port, error: String(err), uptime_secs: null, profile: null });
  }
  btnToggle.disabled = false;
});

// --- UI Update ---
function updateUI(status: ServerStatus): void {
  currentStatus = status.status;
  statusDot.className = "status-dot " + status.status;
  const labels: Record<string, string> = { stopped: "Stopped", starting: "Starting...", running: "Running", error: "Error" };
  statusText.textContent = labels[status.status] || status.status;
  statusMeta.textContent = status.status === "running" ? "port " + status.port : "";

  switch (status.status) {
    case "running":
      btnLabel.textContent = "Stop Server";
      btnIcon.innerHTML = "&#9724;";
      btnToggle.className = "btn-toggle btn-stop";
      btnToggle.disabled = false;
      profileSelect.disabled = true;
      break;
    case "starting":
      btnLabel.textContent = "Starting...";
      btnIcon.innerHTML = "&#8987;";
      btnToggle.className = "btn-toggle btn-starting";
      btnToggle.disabled = true;
      profileSelect.disabled = true;
      break;
    default:
      btnLabel.textContent = "Start Server";
      btnIcon.innerHTML = "&#9654;";
      btnToggle.className = "btn-toggle btn-start";
      btnToggle.disabled = false;
      profileSelect.disabled = false;
      break;
  }

  metricPort.textContent = String(status.port);
  metricUptime.textContent = status.uptime_secs != null ? formatUptime(status.uptime_secs) : "--";
}

function formatUptime(secs: number): string {
  if (secs < 60) return secs + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m " + (secs % 60) + "s";
  return Math.floor(secs / 3600) + "h " + Math.floor((secs % 3600) / 60) + "m";
}

async function pollStatus(): Promise<void> {
  try { const s = await invoke<ServerStatus>("get_server_status"); updateUI(s); } catch { /* retry */ }
}

async function init(): Promise<void> {
  await loadSettings();
  await loadProfiles();
  metricPort.textContent = String(settings.port);
  pollStatus();
  if (settings.auto_start) btnToggle.click();
}

init();
window.setInterval(pollStatus, 2000);
