//! Proxy-safe update flow for loopback feeds.
//!
//! Why this exists: tauri-plugin-updater's `check` command uses reqwest with
//! the `system-proxy` feature enabled. When a system proxy is configured
//! (e.g. the app's own tunnel handoff at `127.0.0.1:<port>`), even a LOOPBACK
//! feed endpoint — the sidecar serving `latest.json` on `127.0.0.1` — is sent
//! through the proxy, which cannot answer for it: the request fails and the
//! plugin reports the opaque "Could not fetch a valid release JSON from the
//! remote". Windows' ProxyOverride bypass list does not help reqwest here.
//!
//! Fix: drive the plugin's public `UpdaterBuilder` with `no_proxy()` when the
//! configured endpoints are loopback, replicating the plugin's own
//! `check`/`download`/`install` command sequence. The download still verifies
//! the minisign signature against the pubkey baked into the build before
//! install — the trust model is unchanged; only the transport path differs.
//! Remote (GitHub) endpoints are untouched: they keep the default system-proxy
//! behavior, which censored-network users may depend on to reach GitHub.

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// How long `feed_install` waits for files about to be replaced (sidecar
/// node.exe, the app exe itself) to become writable before launching the
/// NSIS installer.
const FILE_FREE_TIMEOUT: Duration = Duration::from_secs(15);

/// Observed in the field: the plugin's Windows install flow spawns the NSIS
/// updater process immediately and exits the app concurrently. The sidecar
/// child (backend/node.exe) is still shutting down when the installer reaches
/// it, so the update stalls on NSIS's "Error opening file for writing" retry
/// dialog — a dead-end that needs a human click. Waiting here (same process,
/// before the installer exists) removes the race deterministically: if a file
/// is still locked after the timeout, we report the failure to the caller
/// instead of spawning an installer that can only dead-end.

/// Same shape as the plugin's `Metadata` command response, so the existing
/// webview bridge consumes the result without a new contract.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedCheck {
    available: bool,
    version: String,
    current_version: String,
    body: Option<String>,
}

/// The updater endpoints this build was configured with, read from the same
/// `plugins.updater.endpoints` config the plugin built its state from.
fn configured_endpoints(app: &AppHandle) -> Vec<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("endpoints"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn all_loopback(endpoints: &[String]) -> bool {
    !endpoints.is_empty()
        && endpoints.iter().all(|e| {
            url::Url::parse(e).is_ok_and(|u| {
                matches!(u.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"))
            })
        })
}

fn proxy_bypassing_builder(app: &AppHandle) -> Result<tauri_plugin_updater::UpdaterBuilder, String> {
    let mut builder = app.updater_builder();
    if all_loopback(&configured_endpoints(app)) {
        builder = builder.no_proxy();
    }
    Ok(builder)
}

/// Check the feed for an update, bypassing any system proxy when the
/// configured endpoint is loopback. `available: false` means the feed says
/// the app is current; an unreachable or invalid feed is an Err.
#[tauri::command]
pub async fn feed_check(app: AppHandle) -> Result<FeedCheck, String> {
    let updater = proxy_bypassing_builder(&app)?.build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    Ok(match update {
        Some(u) => FeedCheck {
            available: true,
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            body: u.body.clone(),
        },
        None => {
            let current = app.package_info().version.to_string();
            FeedCheck {
                available: false,
                version: current.clone(),
                current_version: current,
                body: None,
            }
        }
    })
}

/// True when the file can be opened for writing (no other process holds it
/// without FILE_SHARE_WRITE). A plain write-mode open fails with a sharing
/// violation exactly when the NSIS installer's write would fail too.
fn file_is_writable(path: &str) -> bool {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .is_ok()
}

/// Block until `path` is writable or the timeout elapses. Returns false on
/// timeout so the caller can refuse the install honestly.
fn wait_until_writable(path: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if file_is_writable(path) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    file_is_writable(path)
}

/// Download (signature verified inside the plugin), install, and — like the
/// plugin's own Windows flow — exit the app so the installer can replace the
/// binary and restart on the new version.
#[tauri::command]
pub async fn feed_install(app: AppHandle) -> Result<(), String> {
    let updater = proxy_bypassing_builder(&app)?.build().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    // download() verifies the minisign signature inside (against the baked
    // pubkey) and only then returns the bytes.
    let downloaded = update
        .download(|_chunk_len, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // The NSIS updater replaces backend/node.exe (the sidecar runtime) and
    // the app exe. The plugin spawns the installer and exits concurrently, so
    // a still-running sidecar loses the race. Stop the sidecar HERE (the
    // app-quit path does not guarantee it before the installer lands), then
    // wait for any remaining handle to free up — there is no one to answer
    // NSIS's retry dialog once we are gone.
    crate::sidecar::stop_sidecar(&app);
    if let Ok(exe) = std::env::current_exe() {
        let app_dir = exe
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_default();
        let targets = [
            app_dir.join("backend").join("node.exe"),
            app_dir.join("netpulse-desktop.exe"),
        ];
        for t in targets {
            if t.exists() {
                let p = t.to_string_lossy().to_string();
                if !wait_until_writable(&p, FILE_FREE_TIMEOUT) {
                    return Err(format!(
                        "update aborted: {} is still locked by another process",
                        p
                    ));
                }
            }
        }
    }

    // Launches the installer and exits the app on Windows.
    update.install(&downloaded).map_err(|e| e.to_string())?;
    Ok(())
}
