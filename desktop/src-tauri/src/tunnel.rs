use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize)]
pub struct TunnelStatus {
    /// One of: "inactive", "establishing", "active", "failed"
    pub status: String,
    pub tunnel_url: Option<String>,
    pub bearer_token: Option<String>,
    pub error: Option<String>,
}

pub struct TunnelState {
    child: Option<CommandChild>,
    tunnel_url: Option<String>,
    bearer_token: Option<String>,
    status: String,
    error: Option<String>,
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            child: None,
            tunnel_url: None,
            bearer_token: None,
            status: "inactive".to_string(),
            error: None,
        }
    }

    pub fn to_status(&self) -> TunnelStatus {
        TunnelStatus {
            status: self.status.clone(),
            tunnel_url: self.tunnel_url.clone(),
            bearer_token: self.bearer_token.clone(),
            error: self.error.clone(),
        }
    }
}

/// Generate a cryptographically random Bearer token (32 hex chars = 128 bits).
fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub async fn start_tunnel(
    app: &AppHandle,
    tunnel_state: &Arc<Mutex<TunnelState>>,
    sidecar_port: u16,
) -> Result<TunnelStatus, String> {
    let mut guard = tunnel_state.lock().await;

    // Already running
    if guard.child.is_some() {
        return Ok(guard.to_status());
    }

    // Generate new Bearer token for this tunnel session
    let token = generate_token();
    guard.bearer_token = Some(token.clone());
    guard.status = "establishing".to_string();
    guard.error = None;

    let cmd = app.shell().sidecar("binaries/cloudflared")
        .map_err(|e| format!("Failed to create cloudflared command: {}", e))?
        .args([
            "tunnel", "--url",
            &format!("http://localhost:{}", sidecar_port),
            "--no-autoupdate",
        ]);

    let (mut rx, child) = cmd.spawn()
        .map_err(|e| format!("Failed to spawn cloudflared: {}", e))?;
    guard.child = Some(child);

    let status = guard.to_status();
    drop(guard);

    // Monitor cloudflared stdout/stderr for tunnel URL
    let ts = Arc::clone(tunnel_state);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim();
                    eprintln!("[cloudflared] {}", text);

                    // Parse tunnel URL from cloudflared output
                    if let Some(url) = extract_tunnel_url(text) {
                        let mut guard = ts.lock().await;
                        guard.tunnel_url = Some(url.clone());
                        guard.status = "active".to_string();
                        let _ = app_handle.emit("tunnel-ready", url);
                    }
                }
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[cloudflared:stdout] {}", text.trim());

                    if let Some(url) = extract_tunnel_url(text.trim()) {
                        let mut guard = ts.lock().await;
                        guard.tunnel_url = Some(url.clone());
                        guard.status = "active".to_string();
                        let _ = app_handle.emit("tunnel-ready", url);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[cloudflared] terminated: code={:?}", payload.code);
                    let mut guard = ts.lock().await;
                    guard.child = None;
                    guard.status = "failed".to_string();
                    guard.error = Some(format!("cloudflared exited with code {:?}", payload.code));
                    let _ = app_handle.emit("tunnel-exit", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    // Timeout: if tunnel not active within 30s, mark as failed
    let timeout_state = Arc::clone(tunnel_state);
    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let mut guard = timeout_state.lock().await;
        if guard.status == "establishing" {
            guard.status = "failed".to_string();
            guard.error = Some("Tunnel establishment timed out".to_string());
            let _ = timeout_app.emit("tunnel-timeout", ());
        }
    });

    Ok(status)
}

pub async fn stop_tunnel(tunnel_state: &Arc<Mutex<TunnelState>>) -> TunnelStatus {
    let mut guard = tunnel_state.lock().await;
    if let Some(child) = guard.child.take() {
        let _ = child.kill();
        eprintln!("[cloudflared] stopped");
    }
    guard.status = "inactive".to_string();
    guard.tunnel_url = None;
    guard.bearer_token = None;
    guard.error = None;
    guard.to_status()
}

/// Extract tunnel URL from cloudflared log output.
/// cloudflared prints lines like: "https://random-id.trycloudflare.com"
fn extract_tunnel_url(text: &str) -> Option<String> {
    // Look for https://*.trycloudflare.com pattern
    for word in text.split_whitespace() {
        let w = word.trim_matches(|c: char| !c.is_alphanumeric() && c != ':' && c != '/' && c != '.' && c != '-');
        if w.starts_with("https://") && w.contains(".trycloudflare.com") {
            return Some(w.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_token_not_empty() {
        let token = generate_token();
        assert!(!token.is_empty());
        assert_eq!(token.len(), 32); // 16 hex bytes * 2
    }

    #[test]
    fn test_generate_token_unique() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert_ne!(t1, t2);
    }

    #[test]
    fn test_extract_tunnel_url_from_log() {
        let line = "2024-01-01 INF +-----------------------------------------------------------+";
        assert_eq!(extract_tunnel_url(line), None);

        let line = "2024-01-01 INF |  https://abc-def-123.trycloudflare.com                  |";
        assert_eq!(extract_tunnel_url(line), Some("https://abc-def-123.trycloudflare.com".to_string()));

        let line = "https://my-tunnel.trycloudflare.com";
        assert_eq!(extract_tunnel_url(line), Some("https://my-tunnel.trycloudflare.com".to_string()));
    }

    #[test]
    fn test_extract_tunnel_url_no_match() {
        assert_eq!(extract_tunnel_url("some random text"), None);
        assert_eq!(extract_tunnel_url("https://example.com"), None);
    }

    #[test]
    fn test_tunnel_state_initial() {
        let state = TunnelState::new();
        assert_eq!(state.status, "inactive");
        assert!(state.tunnel_url.is_none());
        assert!(state.bearer_token.is_none());
        assert!(state.child.is_none());
    }
}
