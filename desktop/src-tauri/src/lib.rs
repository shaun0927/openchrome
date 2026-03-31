mod sidecar;

use std::sync::Arc;
use sidecar::{SidecarState, SidecarStatus};
use tokio::sync::Mutex;

#[tauri::command]
async fn start_server(
    app: tauri::AppHandle, state: tauri::State<'_, Arc<Mutex<SidecarState>>>, port: Option<u16>,
) -> Result<SidecarStatus, String> {
    sidecar::spawn_sidecar(&app, &state, port.unwrap_or(3100)).await
}

#[tauri::command]
async fn stop_server(state: tauri::State<'_, Arc<Mutex<SidecarState>>>) -> Result<SidecarStatus, String> {
    Ok(sidecar::stop_sidecar(&state).await)
}

#[tauri::command]
async fn get_server_status(state: tauri::State<'_, Arc<Mutex<SidecarState>>>) -> Result<SidecarStatus, String> {
    let guard = state.lock().await;
    Ok(guard.status_response())
}

#[tauri::command]
async fn get_health(state: tauri::State<'_, Arc<Mutex<SidecarState>>>) -> Result<serde_json::Value, String> {
    let guard = state.lock().await;
    let port = guard.port();
    let is_running = guard.is_running();
    drop(guard);
    if !is_running { return Ok(serde_json::json!({ "status": "stopped" })); }
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    match client.get(&url).send().await {
        Ok(resp) => {
            let body = resp.json::<serde_json::Value>().await.unwrap_or(serde_json::json!({"status":"ok"}));
            Ok(body)
        }
        Err(e) => Ok(serde_json::json!({"status":"error","error":format!("{}",e)})),
    }
}

/// Helper: proxy GET to sidecar API and return JSON
async fn proxy_sidecar_api(state: &Arc<Mutex<SidecarState>>, path: &str) -> Result<serde_json::Value, String> {
    let guard = state.lock().await;
    let port = guard.port();
    let is_running = guard.is_running();
    drop(guard);
    if !is_running {
        return Err("Server is not running".to_string());
    }
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("Request failed: {}", e))?;
    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
async fn capture_screenshot(
    state: tauri::State<'_, Arc<Mutex<SidecarState>>>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let sid = session_id.as_deref().unwrap_or("default");
    proxy_sidecar_api(&state, &format!("/api/screenshot?session_id={}", sid)).await
}

#[tauri::command]
async fn get_sessions(state: tauri::State<'_, Arc<Mutex<SidecarState>>>) -> Result<serde_json::Value, String> {
    proxy_sidecar_api(&state, "/api/sessions").await
}

#[tauri::command]
async fn get_tool_calls(
    state: tauri::State<'_, Arc<Mutex<SidecarState>>>,
    session_id: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let mut path = "/api/tool-calls".to_string();
    let mut params = vec![];
    if let Some(sid) = &session_id { params.push(format!("session_id={}", sid)); }
    if let Some(lim) = limit { params.push(format!("limit={}", lim)); }
    if !params.is_empty() { path = format!("{}?{}", path, params.join("&")); }
    proxy_sidecar_api(&state, &path).await
}

#[tauri::command]
async fn get_metrics(state: tauri::State<'_, Arc<Mutex<SidecarState>>>) -> Result<serde_json::Value, String> {
    proxy_sidecar_api(&state, "/api/metrics").await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_state = Arc::new(Mutex::new(SidecarState::new()));
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![
            start_server, stop_server, get_server_status, get_health,
            capture_screenshot, get_sessions, get_tool_calls, get_metrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
