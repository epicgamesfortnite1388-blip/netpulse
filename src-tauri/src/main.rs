//! NetPulse desktop core — process assembly and the IPC surface.
//!
//! This file owns WHAT runs and in WHAT ORDER. Each subsystem it wires up owns
//! HOW it works, in its own module:
//!
//!   - `sidecar`      — spawns/supervises the Node backend, owns the log sink
//!   - `elevation`    — the only path to administrator rights (UAC)
//!   - `window`       — main-window presentation: size, placement, reveal
//!   - `paths`        — the one resolver for the data dir and the log dir
//!   - `safe_mode`    — the `--safe-mode` flag and its single owner
//!   - `status`       — runtime-status snapshot for the System Health page
//!   - `diagnostics`  — redacted log tail and exported diagnostic report
//!   - `os_open`      — the two allow-listed OS handoffs
//!   - `updater_feed` — update feed fetch/parse/verify
//!
//! What deliberately stays here:
//!   - bootstrap: hand the webview its transport credentials, once
//!   - repair/reset commands that cut ACROSS modules (stop + respawn + move files)
//!   - the `setup` / window-event / run-loop wiring, in the order where that
//!     order actually matters (logging before anything can fail, elevation
//!     helper before the single-instance lock, sidecar before the watchdog)
//!
//! There is deliberately no generic `shell`/`fs` IPC surface here. The only
//! commands exposed are the narrow ones in `invoke_handler` below.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod diagnostics;
mod elevation;
mod logging;
mod os_open;
mod paths;
mod ports;
mod safe_mode;
mod sidecar;
mod status;
mod tray;
mod updater_feed;
mod webview_gc;
mod window;

use serde::Serialize;
use logging::{log_error, log_info, log_warn};
use tauri::{AppHandle, Manager};
use window::present_main_window;

/// Everything the webview needs to talk to the backend. Delivered exactly once
/// at startup through this typed command — the token never touches disk or any
/// other channel.
#[derive(Serialize)]
struct Bootstrap {
    api_base: String,
    ws_base: String,
    token: String,
    desktop: bool,
    app_version: String,
    os: String,
    arch: String,
    #[cfg(target_os = "windows")]
    webview2: bool,
}

/// Hand the webview its transport credentials — once the sidecar is actually
/// answering.
///
/// The webview loads from bundled assets and can finish loading long before the
/// Node sidecar has bound its port (a first launch runs migrations and an
/// integrity check). Returning here immediately made the UI's very first health
/// probe fail against a backend that was merely still starting, which surfaced
/// as a "Backend unreachable" banner for the first seconds of every launch.
/// Waiting for the port to answer removes the race: the UI holds "Starting…"
/// while the backend boots, and the first probe it issues is a real one.
///
/// `async` so the wait happens off the main thread (Tauri runs sync commands
/// there); while waiting we hold NO lock on the sidecar state, so the watchdog
/// stays free to respawn a dead child.
#[tauri::command(async)]
fn bootstrap(app: AppHandle) -> Bootstrap {
    let (port, token) = {
        let state = app.state::<sidecar::SidecarState>();
        // A poisoned lock must not panic the webview's bootstrap call — the UI
        // treats a bootstrap failure as Recovery Required and offers repair.
        let inner = state.inner.lock().unwrap_or_else(|p| p.into_inner());
        (inner.port, inner.token.clone())
    };
    let asked = std::time::Instant::now();
    if sidecar::wait_for_sidecar_ready(port, sidecar::BOOTSTRAP_READY_TIMEOUT) {
        let waited = asked.elapsed().as_millis();
        if waited > 250 {
            log_info!("bootstrap: sidecar answered after {waited} ms");
        }
    } else {
        log_warn!(
            "bootstrap: sidecar on port {port} did not answer within {}s — handing the webview the credentials anyway (the UI reports the offline state)",
            sidecar::BOOTSTRAP_READY_TIMEOUT.as_secs()
        );
    }
    Bootstrap {
        // api_base MUST include the /api/v1 prefix: the web transport's
        // apiBase is '/api/v1' and api.ts appends bare resource paths
        // ('/meta/health') to it. (ws_base keeps the bare origin because
        // ws.ts hardcodes '/api/v1/ws' itself.)
        api_base: format!("http://127.0.0.1:{port}/api/v1"),
        ws_base: format!("ws://127.0.0.1:{port}"),
        token,
        desktop: true,
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        #[cfg(target_os = "windows")]
        webview2: true,
    }
}

/// Reset App State: stop the sidecar, move every data file into
/// `backup-<timestamp>/` inside the app data dir (never deleted), then respawn
/// a fresh backend that migrates a new database. Works even when the sidecar
/// is wedged — this is the recovery path for it.
#[tauri::command]
fn reset_app_state(app: AppHandle) -> Result<String, String> {
    let data_dir = paths::require_data_dir(&app)?;
    let backup = data_dir.join(format!(
        "backup-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&backup).map_err(|e| format!("backup dir: {e}"))?;

    // Stop the sidecar FIRST: open SQLite handles on Windows block renames.
    sidecar::stop_sidecar(&app);

    let mut moved = 0usize;
    let entries = std::fs::read_dir(&data_dir).map_err(|e| format!("read data dir: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("backup-") || name == "logs" {
            continue; // keep prior backups and the diagnostic log in place
        }
        if std::fs::rename(entry.path(), backup.join(&name)).is_ok() {
            moved += 1;
        }
    }
    log_info!(
        "reset-state: {} items preserved in {}",
        moved,
        backup.display()
    );

    // Fresh backend, fresh DB, same window.
    sidecar::allow_respawn(&app);
    sidecar::spawn_sidecar(&app).map_err(|e| format!("respawn failed: {e}"))?;
    Ok(backup.to_string_lossy().to_string())
}

/// Restart the sidecar after a failure (Repair App). The watchdog will keep it
/// alive afterwards; the UI reloads against the fresh backend.
#[tauri::command]
fn restart_backend(app: AppHandle) -> Result<(), String> {
    log_info!("repair: restarting backend on user request");
    sidecar::stop_sidecar(&app);
    sidecar::allow_respawn(&app);
    sidecar::spawn_sidecar(&app)
}

/// Logging + panic hook must exist before ANYTHING can fail.
fn init_logging_early() -> Option<String> {
    // Resolve the app data dir without an AppHandle (Tauri dirs come from the
    // identifier; `paths` replicates the default Windows location). If this
    // fails we still log to stderr, which lands in the WebView2 devtools
    // console path and in the debug build's console.
    let dir = paths::data_dir_without_handle().map(|d| d.to_string_lossy().to_string());
    if let Some(d) = &dir {
        logging::init_logging(d);
    }
    logging::install_panic_hook();
    dir
}

fn main() {
    let _early_data_dir = init_logging_early();
    // Elevated-relaunch helper FIRST, before any app work: a helper copy must
    // never take the single-instance lock, sweep webviews or spawn a sidecar —
    // it exists only to wait for this app to exit and then raise one UAC prompt.
    // Logging is initialized above so the helper's outcome is recorded.
    let args: Vec<String> = std::env::args().collect();
    if let Some(parent_pid) = elevation::parse_elevate_after(&args) {
        elevation::run_elevation_helper(parent_pid);
    }
    // Kill webview children orphaned by a previous abnormal exit BEFORE the
    // single-instance plugin runs (a stale webview holding the app's window
    // class can otherwise confuse second-launch handling).
    webview_gc::sweep_orphaned_webviews();
    log_info!("=== NetPulse desktop starting (v{}) ===", env!("CARGO_PKG_VERSION"));
    log_info!("exe: {}", std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "<unknown>".into()));
    let dll_next_to_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("WebView2Loader.dll")))
        .map(|d| d.exists())
        .unwrap_or(false);
    log_info!("WebView2Loader.dll next to exe: {}", dll_next_to_exe);
    log_info!("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: {}", std::env::var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").unwrap_or_else(|_| "<not set>".into()));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of starting a
            // second backend/core.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Updater: registered but inert unless `plugins.updater.active` is
        // true in tauri.conf.json (disabled by default — it stays disabled
        // until real minisign keys and a release feed exist; see RELEASING.md).
        // Updates never run without a valid signature from the configured key.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(sidecar::SidecarState::new())
        .manage(safe_mode::SafeModeState::new())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            paths::data_paths,
            os_open::reveal_path,
            safe_mode::netpulse_safe_mode,
            reset_app_state,
            status::runtime_status,
            diagnostics::read_log_tail,
            diagnostics::save_diagnostic_report,
            restart_backend,
            os_open::open_external,
            elevation::admin_status,
            elevation::relaunch_as_admin,
            elevation::vpn_elevation_bridge,
            updater_feed::feed_check,
            updater_feed::feed_install
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Data dir is decided here (OS-native), passed to the sidecar and
            // used for the file log. Same resolver every reader uses.
            let data_dir = paths::data_dir(&handle);
            std::env::set_var("NETPULSE_DATA_DIR", &data_dir);
            log_info!("data dir: {data_dir}");

            // Safe Mode: `--safe-mode` on the command line launches with the
            // network stack disabled (null controller) so a wedged networking
            // config cannot stop the user from reaching Settings.
            safe_mode::announce_to_sidecar();

            // GUI-first policy: the window is already being created by the
            // config below; nothing in this setup hook is allowed to take it
            // down. Optional subsystems (tray, migrations path, sidecar) fail
            // soft — they log and continue.

            if let Err(e) = tray::build_tray(&handle) {
                log_warn!("tray unavailable (app continues without it): {e}");
            }

            // Migrations folder travels with the bundled backend resources.
            if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
                let mig = exe_dir.join("backend").join("drizzle");
                if mig.exists() {
                    std::env::set_var("NETPULSE_MIGRATIONS_DIR", &mig);
                } else {
                    log_warn!("backend/drizzle not found next to exe; sidecar will rely on NETPULSE_MIGRATIONS_DIR fallback");
                }
            }

            // Sidecar failure must not prevent the GUI. The watchdog will keep
            // trying; the UI shows an honest offline state in the meantime.
            if let Err(e) = sidecar::spawn_sidecar(&handle) {
                log_error!("sidecar failed to start on first attempt (GUI stays up): {e}");
            }
            sidecar::start_watchdog(&handle);

            // Window presentation is deliberately NOT done here — see
            // `window::present_main_window`, which runs on RunEvent::Ready.
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Close-to-tray: hide instead of exiting; Quit is explicit
                // from the tray menu and goes through AppHandle::exit.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            log_error!("tauri build failed: {e}");
            std::process::exit(1);
        });
    app.run(|app, event| {
        // Deterministic sidecar shutdown on every exit path. RunEvent::Exit is
        // delivered AFTER the event loop has torn down — historically a window
        // for the tao "cannot move state from Destroyed" panic on Windows — so
        // the common exits (window close, restart flows) stop the sidecar in
        // ExitRequested instead. The explicit app.exit(0) path (tray Quit)
        // skips ExitRequested-with-code and is covered by the Exit arm below.
        // stop_sidecar is idempotent (shutting_down flag), so double delivery
        // is harmless.
        match event {
            tauri::RunEvent::Ready => {
                present_main_window(app);
            }
            tauri::RunEvent::ExitRequested { code, .. } => {
                if code.is_none() {
                    sidecar::stop_sidecar(app);
                }
            }
            tauri::RunEvent::Exit => {
                sidecar::stop_sidecar(app);
            }
            _ => {}
        }
    });
    log_info!("event loop exited");
}
