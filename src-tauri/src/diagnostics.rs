//! Diagnostics: the redacted log tail the System Health page shows, and the
//! JSON report exported next to the logs.
//!
//! Defense in depth for secret hygiene: the backend already redacts
//! authorization/cookie/token material from its structured logs; this second
//! layer drops any line that still LOOKS like it carries a bearer token,
//! session cookie or PEM key before it ever reaches the webview or a file.
//!
//! The exported report additionally never copies credentials out of the data
//! dir — tokens live only in memory, and the tail passes the same filter as
//! `read_log_tail`.

use std::path::Path;

use tauri::AppHandle;

use crate::paths;
use crate::sidecar::log_info;
use crate::status::{runtime_status, RuntimeStatus};

const SECRET_PATTERNS: [&str; 9] = [
    "authorization",
    "bearer ",
    "cookie",
    "set-cookie",
    "token",
    "secret",
    "private key",
    "presharedkey",
    "password",
];

/// Redacted tail of the startup log for the System Health page.
#[tauri::command]
pub fn read_log_tail(app: AppHandle, lines: usize) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(paths::log_file(&app))
        .map_err(|e| format!("cannot read log: {e}"))?;
    let total = content.lines().count();
    let skip = total.saturating_sub(lines.min(500));
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
pub fn save_diagnostic_report(app: AppHandle) -> Result<String, String> {
    let log_dir = paths::log_dir(&app);
    let status: RuntimeStatus = runtime_status(app.clone());
    let tail = read_log_tail(app.clone(), 200).unwrap_or_default();

    let report = serde_json::json!({
        "generatedAt": unix_now(),
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

    let file = Path::new(&log_dir).join(format!("diagnostic-report-{}.json", unix_now()));
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("log dir: {e}"))?;
    std::fs::write(&file, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| format!("cannot write report: {e}"))?;
    log_info!("diagnostic report written: {}", file.display());
    Ok(file.to_string_lossy().to_string())
}

/// Unix seconds, or 0 if the clock is before the epoch.
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
