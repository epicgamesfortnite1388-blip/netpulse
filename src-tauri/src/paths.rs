//! Where the app's files live — the ONE resolver for both directories.
//!
//! These were previously resolved independently in three places (the `setup`
//! hook, the `data_paths` command and `reset_app_state`), which is exactly the
//! shape of bug where the System Health page reports a path nothing writes to.
//!
//! The trap this module exists to prevent: the rotating diagnostic log lives
//! under the app DATA dir (`<data>/logs`, created by `sidecar::init_logging`
//! before the Tauri app exists), NOT under Tauri's `app_log_dir()`, which
//! resolves to LocalAppData on Windows while `app_data_dir()` resolves to
//! AppData\Roaming. Every reader of the log goes through `log_dir` below.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Tauri's app_data_dir for our identifier, resolved WITHOUT an AppHandle:
/// %APPDATA%\<identifier> (roaming), matching `tauri::PathResolver` on Windows.
///
/// Needed by code that runs before the Tauri app exists (logging init) and as
/// the fallback for every later reader.
pub fn data_dir_without_handle() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|home| PathBuf::from(home).join("app.netpulse.desktop"))
}

/// The app data dir (database, logs, caches) as a path.
///
/// Resolves through Tauri first, then the handle-free mirror above. `None` only
/// when the OS refuses to resolve either.
pub fn data_dir_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .or_else(data_dir_without_handle)
}

/// The app data dir as a string, falling back to "." the way the env var the
/// sidecar reads (`NETPULSE_DATA_DIR`) always needs.
pub fn data_dir(app: &AppHandle) -> String {
    data_dir_path(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

/// Same as `data_dir_path`, but for callers that must refuse rather than guess
/// (anything about to move or delete files).
pub fn require_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))
        .or_else(|e| data_dir_without_handle().ok_or(e))
}

/// `<data>/logs` — where `sidecar::init_logging` actually writes netpulse.log.
pub fn log_dir(app: &AppHandle) -> String {
    match data_dir_path(app) {
        Some(data) => data.join("logs").to_string_lossy().to_string(),
        None => data_dir_without_handle()
            .map(|d| d.join("logs").to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string()),
    }
}

/// Path of the rotating log file itself.
pub fn log_file(app: &AppHandle) -> PathBuf {
    PathBuf::from(log_dir(app)).join("netpulse.log")
}

/// Current size of the rotating log, 0 when it does not exist yet.
pub fn log_file_bytes(app: &AppHandle) -> u64 {
    std::fs::metadata(log_file(app)).map(|m| m.len()).unwrap_or(0)
}

/// Native application-data directory for the backend, exposed to the UI (About
/// screen, log viewer) and diagnostics.
#[derive(Serialize)]
pub struct DataPaths {
    pub data_dir: String,
    pub log_dir: String,
}

#[tauri::command]
pub fn data_paths(app: AppHandle) -> DataPaths {
    DataPaths {
        data_dir: data_dir(&app),
        log_dir: log_dir(&app),
    }
}
