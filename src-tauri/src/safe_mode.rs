//! Safe Mode — the single owner of one boolean.
//!
//! Safe Mode is requested with `--safe-mode`/`-s` on the command line (e.g.
//! from a Start Menu shortcut copy). It is consumed BEFORE the first window
//! exists, which means the argument list can only be parsed once, at startup:
//! the result is stored in managed state and every later reader asks this
//! module. (The runtime-status command used to re-parse `argv` independently,
//! leaving two sources of truth for the same flag.)

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::logging::log_info;

/// Managed flag so the IPC command can answer without touching `argv` again.
pub struct SafeModeState(AtomicBool);

impl SafeModeState {
    pub fn new() -> Self {
        SafeModeState(AtomicBool::new(from_args()))
    }

    pub fn active(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

impl Default for SafeModeState {
    fn default() -> Self {
        Self::new()
    }
}

/// The flag as written on the command line. Only `main` and `SafeModeState::new`
/// may call this; everything else goes through `is_active`.
fn from_args() -> bool {
    std::env::args().any(|a| a == "--safe-mode" || a == "-s")
}

/// Is this launch a Safe Mode launch?
pub fn is_active(app: &AppHandle) -> bool {
    app.try_state::<SafeModeState>()
        .map(|s| s.active())
        .unwrap_or_else(from_args)
}

/// Tell the sidecar to start with its network stack disabled (null controller)
/// so a wedged networking config cannot stop the user from reaching Settings.
///
/// Returns whether Safe Mode is on for this launch.
pub fn announce_to_sidecar() -> bool {
    let on = from_args();
    if on {
        std::env::set_var("NETPULSE_SAFE_MODE", "1");
        log_info!("SAFE MODE requested: network stack disabled for this launch");
    }
    on
}

#[tauri::command]
pub fn netpulse_safe_mode(state: tauri::State<'_, SafeModeState>) -> bool {
    state.active()
}
