use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::Mutex;
use tokio::time::sleep;

const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarStatus {
    pub status: String,
    pub port: u16,
    pub error: Option<String>,
    pub uptime_secs: Option<u64>,
}

pub struct SidecarState {
    child: Option<CommandChild>,
    port: u16,
    started_at: Option<std::time::Instant>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self { child: None, port: 3100, started_at: None }
    }
    pub fn port(&self) -> u16 { self.port }
    pub fn is_running(&self) -> bool { self.child.is_some() }
    pub fn status_response(&self) -> SidecarStatus {
        let status = if self.child.is_some() { "running" } else { "stopped" };
        let uptime_secs = self.started_at.map(|t| t.elapsed().as_secs());
        SidecarStatus { status: status.to_string(), port: self.port, error: None, uptime_secs }
    }
}

pub async fn spawn_sidecar(
    app: &AppHandle, state: &Arc<Mutex<SidecarState>>, port: u16,
) -> Result<SidecarStatus, String> {
    let mut guard = state.lock().await;
    if guard.child.is_some() { return Ok(guard.status_response()); }
    guard.port = port;

    let cmd = app.shell().sidecar("binaries/openchrome-sidecar")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["serve", "--http", &port.to_string(), "--auto-launch", "--server-mode"]);

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("Failed to spawn sidecar: {}", e))?;
    guard.child = Some(child);
    guard.started_at = Some(std::time::Instant::now());

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[sidecar] {}", text.trim_end());
                    let _ = app_handle.emit("sidecar-log", text.to_string());
                }
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[sidecar:stdout] {}", text.trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] terminated: code={:?} signal={:?}", payload.code, payload.signal);
                    let _ = app_handle.emit("sidecar-exit", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    let status = guard.status_response();
    drop(guard);

    let health_state = Arc::clone(state);
    let health_app = app.clone();
    tauri::async_runtime::spawn(async move {
        match wait_for_health(port).await {
            Ok(()) => {
                eprintln!("[sidecar] health check passed on port {}", port);
                let _ = health_app.emit("sidecar-ready", port);
            }
            Err(e) => {
                eprintln!("[sidecar] health check failed: {}", e);
                let _ = health_app.emit("sidecar-health-failed", e.clone());
                let mut guard = health_state.lock().await;
                if let Some(child) = guard.child.take() {
                    let _ = child.kill();
                    guard.started_at = None;
                }
            }
        }
    });

    Ok(SidecarStatus { status: "starting".to_string(), ..status })
}

pub async fn stop_sidecar(state: &Arc<Mutex<SidecarState>>) -> SidecarStatus {
    let mut guard = state.lock().await;
    if let Some(child) = guard.child.take() {
        let _ = child.kill();
        eprintln!("[sidecar] stopped");
    }
    guard.started_at = None;
    guard.status_response()
}

async fn wait_for_health(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let deadline = tokio::time::Instant::now() + HEALTH_CHECK_TIMEOUT;
    loop {
        if tokio::time::Instant::now() > deadline {
            return Err("Health check timed out".to_string());
        }
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => {}
        }
        sleep(HEALTH_CHECK_INTERVAL).await;
    }
}
