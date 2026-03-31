use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChromeProfile {
    pub id: String,
    pub name: String,
}

/// Detect installed Chrome profiles with friendly names.
pub fn detect_profiles() -> Vec<ChromeProfile> {
    let base = match chrome_user_data_dir() {
        Some(p) if p.exists() => p,
        _ => return vec![],
    };

    let local_state_path = base.join("Local State");
    let profile_dirs = read_profile_dirs(&local_state_path)
        .unwrap_or_else(|| vec!["Default".to_string()]);

    profile_dirs
        .into_iter()
        .map(|dir_name| {
            let prefs_path = base.join(&dir_name).join("Preferences");
            let friendly = read_profile_name(&prefs_path).unwrap_or_else(|| dir_name.clone());
            ChromeProfile { id: dir_name, name: friendly }
        })
        .collect()
}

fn chrome_user_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        // dirs::config_dir() returns ~/Library/Application Support on macOS
        dirs::config_dir().map(|d| d.join("Google").join("Chrome"))
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("Google").join("Chrome").join("User Data"))
    }
    #[cfg(target_os = "linux")]
    {
        dirs::config_dir().map(|d| d.join("google-chrome"))
    }
}

fn read_profile_dirs(path: &PathBuf) -> Option<Vec<String>> {
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let cache = json.get("profile")?.get("info_cache")?.as_object()?;
    Some(cache.keys().cloned().collect())
}

fn read_profile_name(path: &PathBuf) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("profile")?.get("name")?.as_str().map(|s| s.to_string())
}
