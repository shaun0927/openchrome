// OpenChrome Desktop — Tauri application entry point

mod ipc;
mod sidecar;

use std::sync::Arc;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_state = Arc::new(Mutex::new(sidecar::SidecarState::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![
            ipc::start_server,
            ipc::stop_server,
            ipc::get_server_status,
            ipc::get_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
