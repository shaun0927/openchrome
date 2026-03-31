use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChromeProfile {
    /// Internal directory name (e.g., "Default", "Profile 1")
    pub id: String,
    /// Friendly name from Chrome preferences (e.g., "Personal", "Work")
    pub name: String,
}

/// Detect installed Chrome profiles with friendly names.
pub fn detect_profiles() -> Vec<ChromeProfile> {
    let base = chrome_user_data_dir();
    let base = match base {
        Some(p) if p.exists() => p,
        _ => return vec![],
    };

    // Read Local State to find profile directories
    let local_state_path = base.join("Local State");
    let profile_dirs = read_profile_dirs_from_local_state(&local_state_path)
        .unwrap_or_else(|| vec!["Default".to_string()]);

    let mut profiles = Vec::new();

    for dir_name in profile_dirs {
        let prefs_path = base.join(&dir_name).join("Preferences");
        let friendly_name = read_profile_name(&prefs_path).unwrap_or_else(|| dir_name.clone());

        profiles.push(ChromeProfile {
            id: dir_name,
            name: friendly_name,
        });
    }

    profiles
}

/// Platform-specific Chrome user data directory
fn chrome_user_data_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;

    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Application Support/Google/Chrome"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("Google").join("Chrome").join("User Data"))
    }

    #[cfg(target_os = "linux")]
    {
        Some(home.join(".config/google-chrome"))
    }
}

/// Parse Local State JSON to extract profile directory names
fn read_profile_dirs_from_local_state(path: &PathBuf) -> Option<Vec<String>> {
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;

    let info_cache = json
        .get("profile")?
        .get("info_cache")?
        .as_object()?;

    Some(info_cache.keys().cloned().collect())
}

/// Read friendly profile name from Preferences file
fn read_profile_name(prefs_path: &PathBuf) -> Option<String> {
    let content = std::fs::read_to_string(prefs_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;

    json.get("profile")?
        .get("name")?
        .as_str()
        .map(|s| s.to_string())
}
