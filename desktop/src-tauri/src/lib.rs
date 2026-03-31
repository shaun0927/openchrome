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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_state = Arc::new(Mutex::new(SidecarState::new()));
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![start_server, stop_server, get_server_status, get_health])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
