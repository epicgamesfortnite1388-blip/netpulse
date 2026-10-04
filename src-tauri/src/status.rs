//! Runtime status of the Rust core + sidecar, polled by the System Health page
//! to build the Starting → Checking → Ready/Degraded/Recovery state machine.
//!
//! This is an aggregator, not an owner: it reads the sidecar, the path
//! resolvers, the safe-mode flag and the window, and composes one snapshot.
//! A poisoned sidecar lock degrades the snapshot (running = false) instead of
//! taking the whole page down with it.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{paths, safe_mode, sidecar};

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub sidecar_running: bool,
    pub sidecar_restarts: u32,
    /// Loopback port the sidecar is listening on (None = not running).
    pub sidecar_port: Option<u16>,
    /// Why the sidecar last restarted (decoded exit code + stderr tail), or
    /// None if it has never died since this app process started.
    pub last_restart_reason: Option<String>,
    /// Unix seconds of the last sidecar restart.
    pub last_restart_at_unix: Option<u64>,
    pub safe_mode: bool,
    pub window_visible: bool,
    pub data_dir: String,
    pub log_dir: String,
    pub log_file_bytes: u64,
    pub log_rotation_cap_bytes: u64,
}

#[tauri::command]
pub fn runtime_status(app: AppHandle) -> RuntimeStatus {
    let state = app.state::<sidecar::SidecarState>();
    let (running, restarts, port, last_reason, last_at) = match state.inner.lock() {
        Ok(mut inner) => (
            inner
                .child
                .as_mut()
                .map(|c| c.try_wait().map(|s| s.is_none()).unwrap_or(false))
                .unwrap_or(false),
            inner.restarts,
            if inner.child.is_some() { Some(inner.port) } else { None },
            inner.last_restart_reason.clone(),
            inner.last_restart_at_unix,
        ),
        Err(_) => (false, 0, None, None, None),
    };
    RuntimeStatus {
        sidecar_running: running,
        sidecar_restarts: restarts,
        sidecar_port: port,
        last_restart_reason: last_reason,
        last_restart_at_unix: last_at,
        safe_mode: safe_mode::is_active(&app),
        window_visible: app
            .get_webview_window("main")
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false),
        data_dir: paths::data_dir(&app),
        log_dir: paths::log_dir(&app),
        log_file_bytes: paths::log_file_bytes(&app),
        log_rotation_cap_bytes: crate::logging::LOG_CAP_BYTES,
    }
}
