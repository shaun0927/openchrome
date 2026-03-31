//! Persistent application settings stored as human-readable JSON.
//! Path: platform app-data directory / openchrome-desktop / config.json

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// Selected Chrome profile directory name (e.g. "Default", "Profile 1")
    #[serde(default)]
    pub selected_profile: String,
    /// Server port (default: 3100)
    #[serde(default = "default_port")]
    pub port: u16,
    /// Auto-start server when app launches
    #[serde(default)]
    pub auto_start: bool,
}

fn default_port() -> u16 {
    3100
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_profile: String::new(),
            port: 3100,
            auto_start: false,
        }
    }
}

/// Platform-appropriate settings directory
fn settings_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
    });
    base.join("openchrome-desktop")
}

fn settings_path() -> PathBuf {
    settings_dir().join("config.json")
}

/// Load settings from disk, returning defaults if file is missing or corrupt.
pub fn load() -> AppSettings {
    let path = settings_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

/// Save settings to disk. Creates the directory if needed.
pub fn save(settings: &AppSettings) -> Result<(), String> {
    let dir = settings_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create settings dir: {}", e))?;

    let path = settings_path();
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    std::fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))
}
