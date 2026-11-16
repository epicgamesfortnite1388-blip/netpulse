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
mod dpapi;
mod elevation;
mod logging;
mod navigation;
mod network_intelligence;
mod os_open;
mod paths;
mod ports;
mod commands;
mod safe_mode;
mod sidecar;
mod status;
mod tray;
mod updater_feed;
mod webview_gc;
mod window;

use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, mpsc, Mutex};
use logging::{log_error, log_info, log_warn};
use tauri::{AppHandle, Manager};
use window::present_main_window;

use commands::nani::NaniState;
use network_intelligence::api_intelligence::registry::{ApiEntry, ApiRegistry};
use network_intelligence::api_intelligence::monitor_loop::MonitorLoop;
use network_intelligence::events::EventBus;
use network_intelligence::foundation::NaniMathEngine;
use network_intelligence::persistence::PersistenceStore;
use network_intelligence::recovery::RecoveryPlanner;

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
        .manage(NaniState {
            events: Mutex::new(None),
            persistence: Mutex::new(PersistenceStore::default()),
            registry: Mutex::new(ApiRegistry::new(EventBus::default())),
            recovery: Arc::new(Mutex::new(RecoveryPlanner::new())),
            learning: Arc::new(Mutex::new(network_intelligence::learning::LearningEngine::new())),
            investigations: Arc::new(Mutex::new(
                network_intelligence::investigation::InvestigationManager::new(
                    EventBus::default(),
                    ApiRegistry::new(EventBus::default()),
                    Arc::new(Mutex::new(
                        network_intelligence::learning::LearningEngine::new(),
                    )),
                ),
            )),
            ai: Mutex::new(network_intelligence::ai::LocalLlm::from_env()),
            math: Arc::new(Mutex::new(NaniMathEngine::new())),
            events_rx: Mutex::new(None),
        })
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
            updater_feed::feed_install,
            dpapi::secret_protect,
            dpapi::secret_unprotect,
            commands::nani::nani_poll_events,
            commands::nani::nani_status,
            commands::nani::nani_health_check_all,
            commands::nani::nani_learning_status,
            commands::nani::nani_learning_drift,
            commands::nani::nani_learning_reset,
            commands::nani::nani_personalization_status,
            commands::nani::nani_personalization_transitions,
            commands::nani::nani_context_observe,
            commands::nani::nani_personalization_delete,
            commands::nani::nani_ai_status,
            commands::nani::nani_explain,
            commands::nani::nani_start_investigation,
            commands::nani::nani_cancel_investigation,
            commands::nani::nani_investigation_status,
            commands::nani::nani_investigations,
            commands::nani::nani_math_entropy,
            commands::nani::nani_math_rank_hypotheses,
            commands::nani::nani_math_select_probe,
            commands::nani::nani_math_hypothesis_view,
            commands::nani::nani_math_should_stop,
            commands::nani::nani_math_drift_analysis,
            commands::nani::nani_math_changepoint_analysis,
            commands::nani::nani_math_mutual_information,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Data dir is decided here (OS-native), passed to the sidecar and
            // used for the file log. Same resolver every reader uses.
            let data_dir = paths::data_dir(&handle);
            std::env::set_var("NETPULSE_DATA_DIR", &data_dir);
            log_info!("data dir: {data_dir}");

            // Load local network profiles before the monitor loop starts. A
            // corrupt file is reported through learning status and starts
            // clean; it is never interpreted as valid evidence.
            {
                let state = handle.state::<NaniState>();
                let loaded = network_intelligence::learning::LearningEngine::with_data_dir(Path::new(&data_dir));
                if let Some(err) = loaded.storage_error() {
                    log_warn!("personalization storage ignored: {err}");
                }
                *state.learning.lock().unwrap_or_else(|p| p.into_inner()) = loaded;
            }

            // Read-only context watchdog: every 2 minutes classify the active
            // adapter and select the matching local profile. Failure is
            // silent; NANI never invents a context.
            {
                let learning = handle.state::<NaniState>().learning.clone();
                std::thread::spawn(move || loop {
                    if let Some(signals) =
                        network_intelligence::context::collector::collect_context()
                    {
                        let _ = learning
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .observe_network(&signals);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(120));
                });
            }

            // Safe Mode: `--safe-mode` on the command line launches with the
            // network stack disabled (null controller) so a wedged networking
            // config cannot stop the user from reaching Settings.
            // Safe Mode is parsed ONCE, into managed state, before any window
            // exists. Announce the value that was parsed rather than reading
            // `argv` a second time — the backend acts on this one, so it has
            // to be the same boolean everything else reports.
            let safe_mode_on = handle.state::<safe_mode::SafeModeState>().active();
            safe_mode::announce_to_sidecar(safe_mode_on);

            // GUI-first policy: the window is the first thing this hook builds,
            // and nothing after it is allowed to take it down. Optional
            // subsystems (tray, migrations path, sidecar) fail soft — they log
            // and continue.
            //
            // The window is created HERE, not by `tauri.conf.json`, because
            // only the builder can carry `on_navigation` / `on_new_window`.
            // Those put the navigation rule in front of the very first
            // navigation, before any page script could install the JS guard
            // (see `navigation.rs`). A failure here is fatal by design: running
            // a GUI app with no window would be a headless backend nobody can
            // reach.
            if let Err(e) = window::create_main_window(&handle) {
                log_error!("could not create the main window: {e}");
                return Err(e.into());
            }

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

            // NANI reactive event bus: wire the AppHandle so Rust-emitted
            // events reach the webview via the `nani:event` Tauri channel
            // (web mode polls `nani_poll_events` instead).
            let (nani_bus, nani_rx) = network_intelligence::events::EventBus::new();
            nani_bus.set_app(app.handle().clone());
            {
                let nani_state = app.state::<NaniState>();
                *nani_state.events.lock().unwrap() = Some(nani_bus.clone());
                *nani_state.events_rx.lock().unwrap() = Some(nani_rx);
                // Replace the placeholder event bus (built at .manage() time)
                // with the real bus wired to the AppHandle.
                nani_state
                    .registry
                    .lock()
                    .unwrap()
                    .set_event_bus(nani_bus.clone());

                // Register the APIs the desktop depends on. Endpoints are
                // descriptive only; no secrets are stored here.
                {
                    let mut registry = nani_state.registry.lock().unwrap();
                    // Only APIs the product actually depends on are monitored.
                    // External AI providers are not part of the default
                    // execution path and must not generate background probes.
                    // Point at the public health route, not the API root. The
                    // root answers 401 (it requires auth), which the probe
                    // classifies as an authentication failure and can therefore
                    // never report Healthy — every health check used to return
                    // 0/1 and trip the circuit breaker on a reachable service.
                    registry.register(ApiEntry::new(
                        "netpulse-cloud",
                        "NetPulse Cloud",
                        "https://netpulse-cloud.shuridehradin.workers.dev/api/v1/health",
                    ));
                }

                // N0 fixes (FABLE/NANI-001, NANI-002): the investigation
                // manager must observe the SAME registry the health-check
                // and monitor paths use, and publish lifecycle events on the
                // SAME bus the frontend subscribes to. Both are Arc-shared:
                // `set_registry` clones the authoritative handle (later
                // registrations are visible), `set_event_bus` shares one
                // sequence space and replay buffer. This runs before the
                // monitor loop and before any UI can start an investigation.
                {
                    let mut investigations = nani_state.investigations.lock().unwrap();
                    investigations
                        .set_registry(nani_state.registry.lock().unwrap().clone());
                    investigations.set_event_bus(nani_bus.clone());
                }

                // Spawn the live monitor loop: polls each registered API,
                // respects circuit breakers, applies bounded retries with
                // jitter, and triggers recovery on breaker trips.
                let recovery = nani_state.recovery.clone();
                let events = nani_bus.clone();
                let registry = nani_state.registry.lock().unwrap().clone();

                // Persist observations and model state to the app data dir.
                *nani_state.persistence.lock().unwrap() =
                    PersistenceStore::new(Path::new(&data_dir))?;

                let learning = nani_state.learning.clone();
                let monitor = MonitorLoop::new(registry, events, recovery, learning);
                monitor.spawn();
            }

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
