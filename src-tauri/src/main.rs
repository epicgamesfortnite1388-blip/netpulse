//! NetPulse desktop core.
//!
//! Responsibilities (see docs/DESKTOP.md):
//!   - bootstrap the React UI from bundled assets
//!   - supervise the Node/TypeScript backend as a private loopback sidecar
//!   - hand the ephemeral sidecar credentials to the webview via typed IPC only
//!   - single-instance enforcement, tray, native paths
//!
//! There is deliberately no generic `shell`/`fs` IPC surface here. The only
//! commands exposed are the narrow ones in `invoke_handler` below.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod elevation;
mod sidecar;

use serde::Serialize;
use sidecar::{log_error, log_info, log_warn};
use tauri::{AppHandle, Manager};

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

#[tauri::command]
fn netpulse_safe_mode(state: tauri::State<'_, SafeModeState>) -> bool {
    state.0.load(std::sync::atomic::Ordering::Relaxed)
}

/// Safe Mode is requested with `--safe-mode` on the command line (e.g. from a
/// Start Menu shortcut copy). It is consumed BEFORE the first window exists.
fn detect_safe_mode() -> bool {
    std::env::args().any(|a| a == "--safe-mode" || a == "-s")
}

/// Managed flag so the IPC command can answer without re-parsing args.
struct SafeModeState(std::sync::atomic::AtomicBool);

/// Reset App State: stop the sidecar, move every data file into
/// `backup-<timestamp>/` inside the app data dir (never deleted), then respawn
/// a fresh backend that migrates a new database. Works even when the sidecar
/// is wedged — this is the recovery path for it.
#[tauri::command]
fn reset_app_state(app: AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
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

#[tauri::command]
fn bootstrap(app: AppHandle) -> Bootstrap {
    let state = app.state::<sidecar::SidecarState>();
    // A poisoned lock must not panic the webview's bootstrap call — the UI
    // treats a bootstrap failure as Recovery Required and offers repair.
    let inner = state.inner.lock().unwrap_or_else(|p| p.into_inner());
    Bootstrap {
        // api_base MUST include the /api/v1 prefix: the web transport's
        // apiBase is '/api/v1' and api.ts appends bare resource paths
        // ('/meta/health') to it. (ws_base keeps the bare origin because
        // ws.ts hardcodes '/api/v1/ws' itself.)
        api_base: format!("http://127.0.0.1:{}/api/v1", inner.port),
        ws_base: format!("ws://127.0.0.1:{}", inner.port),
        token: inner.token.clone(),
        desktop: true,
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        #[cfg(target_os = "windows")]
        webview2: true,
    }
}

/// Native application-data directory for the backend (database, logs, caches).
/// Passed to the sidecar as NETPULSE_DATA_DIR at spawn time; exposed here for
/// the UI (About screen, log viewer) and diagnostics.
#[derive(Serialize)]
struct DataPaths {
    data_dir: String,
    log_dir: String,
}

#[tauri::command]
fn data_paths(app: AppHandle) -> DataPaths {
    let data = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let log = log_dir_of(&app);
    DataPaths {
        data_dir: data,
        log_dir: log,
    }
}

/// Ask the OS to reveal a path in the file manager (used by "Open Logs").
///
/// Security: the webview may only reveal the app's own data/log directories.
/// The allow-list is enforced with canonicalized prefix matching, so `..`
/// traversal, symlink games and UNC tricks cannot escape it.
#[tauri::command]
fn reveal_path(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::path::PathBuf;

    let requested = PathBuf::from(&path);
    if !requested.is_absolute() {
        return Err("path must be absolute".into());
    }

    // Build the allow-list from the same dirs the app itself uses.
    let mut allowed: Vec<PathBuf> = Vec::new();
    if let Some(dir) = app.path().app_data_dir().ok() {
        allowed.push(dir);
    }
    if let Some(dir) = app.path().app_log_dir().ok() {
        allowed.push(dir);
    }
    if allowed.is_empty() {
        return Err("no allowed reveal directories available".into());
    }

    // Best-effort canonicalization (resolves `..`, symlinks where the target
    // exists); fall back to lexical cleaning for not-yet-created paths.
    let canonical = requested.canonicalize().unwrap_or_else(|_| {
        let p = requested.clone();
        let mut comps: std::collections::VecDeque<_> = p.components().collect();
        let mut out = PathBuf::new();
        while let Some(c) = comps.pop_front() {
            use std::path::Component;
            match c {
                Component::CurDir => {}
                Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    });

    let ok = allowed.iter().any(|base| match base.canonicalize() {
        Ok(b) => canonical.starts_with(&b),
        // Base dir may not exist yet on first run — compare lexically.
        Err(_) => canonical.starts_with(base),
    });
    if !ok {
        return Err("path is outside the app's allowed directories".into());
    }

    #[cfg(target_os = "windows")]
    {
        // Use explorer with a validated absolute path; no shell involved.
        std::process::Command::new("explorer")
            .arg(&canonical)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        // `open -R` reveals in Finder without executing the target.
        std::process::Command::new("open")
            .arg("-R")
            .arg(&canonical)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Runtime status of the Rust core + sidecar, polled by the System Health page
/// to build the Starting → Checking → Ready/Degraded/Recovery state machine.
#[derive(Serialize)]
struct RuntimeStatus {
    sidecar_running: bool,
    sidecar_restarts: u32,
    /// Loopback port the sidecar is listening on (None = not running).
    sidecar_port: Option<u16>,
    /// Why the sidecar last restarted (decoded exit code + stderr tail), or
    /// None if it has never died since this app process started.
    last_restart_reason: Option<String>,
    /// Unix seconds of the last sidecar restart.
    last_restart_at_unix: Option<u64>,
    safe_mode: bool,
    window_visible: bool,
    data_dir: String,
    log_dir: String,
    log_file_bytes: u64,
    log_rotation_cap_bytes: u64,
}

#[tauri::command]
fn runtime_status(app: AppHandle) -> RuntimeStatus {
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
    let data = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let log_dir_v = log_dir_of(&app);
    let log_bytes = std::fs::metadata(std::path::Path::new(&log_dir_v).join("netpulse.log"))
        .map(|m| m.len())
        .unwrap_or(0);
    let window_visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    RuntimeStatus {
        sidecar_running: running,
        sidecar_restarts: restarts,
        sidecar_port: port,
        last_restart_reason: last_reason,
        last_restart_at_unix: last_at,
        safe_mode: detect_safe_mode(),
        window_visible,
        data_dir: data,
        log_dir: log_dir_v,
        log_file_bytes: log_bytes,
        log_rotation_cap_bytes: sidecar::LOG_CAP_BYTES,
    }
}

/// Redacted tail of the startup log for the System Health page.
///
/// Defense in depth for secret hygiene: the backend already redacts
/// authorization/cookie/token material from its structured logs; this second
/// layer drops any line that still LOOKS like it carries a bearer token,/// session cookie or PEM key before it ever reaches the webview.
#[tauri::command]
fn read_log_tail(app: AppHandle, lines: usize) -> Result<Vec<String>, String> {
    let dir = log_dir_of(&app);
    let path = std::path::Path::new(&dir).join("netpulse.log");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read log: {e}"))?;
    let total = content.lines().count();
    let skip = total.saturating_sub(lines.min(500));
    const SECRET_PATTERNS: [&str; 9] = [
        "authorization", "bearer ", "cookie", "set-cookie", "token", "secret", "private key", "presharedkey", "password",
    ];
    let mut out = Vec::new();
    for line in content.lines().skip(skip) {
        let lower = line.to_lowercase();
        if SECRET_PATTERNS.iter().any(|p| lower.contains(p)) {
            out.push("[redacted by diagnostics filter]".to_string());
        } else {
            out.push(line.to_string());
        }
    }
    Ok(out)
}

/// Export a diagnostic report (JSON) next to the logs. Contains versions,
/// runtime status, boot-stage journal and the redacted log tail — never
/// secrets: tokens live only in memory, credentials in the data dir are NOT
/// copied, and the log tail passes the same secret filter as read_log_tail.
#[tauri::command]
fn save_diagnostic_report(app: AppHandle) -> Result<String, String> {
    let log_dir = log_dir_of(&app);
    let status = runtime_status(app.clone());
    let tail = read_log_tail(app.clone(), 200).unwrap_or_default();

    let report = serde_json::json!({
        "generatedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "appVersion": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "buildType": if cfg!(debug_assertions) { "debug" } else { "release" },
        "runtimeStatus": {
            "sidecarRunning": status.sidecar_running,
            "sidecarRestarts": status.sidecar_restarts,
            "safeMode": status.safe_mode,
            "windowVisible": status.window_visible,
        },
        "paths": {
            "dataDir": status.data_dir,
            "logDir": status.log_dir,
        },
        "bootLogTail": tail,
        "note": "Secrets are never included: daemon tokens are memory-only, VPN credentials/private keys are not copied, and log lines matching secret patterns are redacted."
    });

    let file = std::path::Path::new(&log_dir).join(format!(
        "diagnostic-report-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("log dir: {e}"))?;
    std::fs::write(&file, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| format!("cannot write report: {e}"))?;
    log_info!("diagnostic report written: {}", file.display());
    Ok(file.to_string_lossy().to_string())
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

/// Open an https URL in the user's default browser.
///
/// Security: strict allowlist — https scheme only, no userinfo/credentials,
/// host required. Opened via the OS protocol handler WITHOUT any shell
/// (no cmd/bash interpreter in the chain), so URL metacharacters can never
/// reach a command interpreter.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only https:// URLs can be opened".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs containing credentials are not allowed".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("URL has no host".into());
    }
    log_info!("opening external link for host {host}");
    #[cfg(target_os = "windows")]
    {
        // FileProtocolHandler dispatches to the default browser directly.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", parsed.as_str()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Logging + panic hook must exist before ANYTHING can fail.
fn init_logging_early() -> Option<String> {
    // Resolve app data dir without an AppHandle (Tauri dirs come from the
    // identifier; replicate the default Windows location). If this fails we
    // still log to stderr, which lands in the WebView2 devtools console path
    // and in the debug build's console.
    let dir = dirs_data_dir();
    if let Some(d) = &dir {
        sidecar::init_logging(d);
    }
    sidecar::install_panic_hook();
    dir
}

/// Mirrors Tauri's app_data_dir for our identifier without needing a handle:
/// %APPDATA%\<identifier> (roaming, matching tauri::PathResolver on Windows).
fn dirs_data_dir() -> Option<String> {
    if let Some(home) = std::env::var_os("APPDATA") {
        let p = std::path::PathBuf::from(home).join("app.netpulse.desktop");
        return Some(p.to_string_lossy().to_string());
    }
    None
}

/// The rotating diagnostic log lives under the app DATA dir (`<data>/logs`,
/// created by `init_logging` before the Tauri app exists) — NOT under Tauri's
/// `app_log_dir()`, which resolves elsewhere on Windows (LocalAppData). Every
/// reader of the log must go through this one resolver or the System Health
/// page ends up reading a log file that was never written.
fn log_dir_of(app: &AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.join("logs").to_string_lossy().to_string())
        .unwrap_or_else(|_| dirs_data_dir().map(|d| format!("{d}\\logs")).unwrap_or_else(|| ".".to_string()))
}

fn main() {
    let _early_data_dir = init_logging_early();
    // Kill webview children orphaned by a previous abnormal exit BEFORE the
    // single-instance plugin runs (a stale webview holding the app's window
    // class can otherwise confuse second-launch handling).
    sidecar::sweep_orphaned_webviews();
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
        .manage(SafeModeState(std::sync::atomic::AtomicBool::new(detect_safe_mode())))
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            data_paths,
            reveal_path,
            netpulse_safe_mode,
            reset_app_state,
            runtime_status,
            read_log_tail,
            save_diagnostic_report,
            restart_backend,
            open_external,
            elevation::vpn_elevation_bridge
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Data dir is decided here (OS-native), passed to the sidecar and
            // used for the file log.
            let data_dir = handle
                .path()
                .app_data_dir()
                .map(|p| p.to_string_lossy().to_string())
                .map(Some)
                .unwrap_or_else(|_| dirs_data_dir())
                .unwrap_or_else(|| ".".to_string());
            std::env::set_var("NETPULSE_DATA_DIR", &data_dir);
            log_info!("data dir: {data_dir}");

            // Safe Mode: `--safe-mode` on the command line launches with the
            // network stack disabled (null controller) so a wedged networking
            // config cannot stop the user from reaching Settings.
            if detect_safe_mode() {
                std::env::set_var("NETPULSE_SAFE_MODE", "1");
                log_info!("SAFE MODE requested: network stack disabled for this launch");
            }

            // GUI-first policy: the window is already being created by the
            // config below; nothing in this setup hook is allowed to take it
            // down. Optional subsystems (tray, migrations path, sidecar) fail
            // soft — they log and continue.

            if let Err(e) = sidecar::build_tray(&handle) {
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

            // Defensive visibility: if anything above left the window hidden
            // or minimized, bring it back to a centered, focused state.
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.center();
                let _ = win.set_focus();
                log_info!("main window shown/centered/focused");
            } else {
                log_error!("main window handle missing after setup");
            }

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
