//! Diagnostics: the redacted log tail the System Health page shows, and the
//! JSON report exported next to the logs.
//!
//! Defense in depth for secret hygiene: the backend already redacts
//! authorization/cookie/token material from its structured logs; this second
//! layer drops any line that still LOOKS like it carries a bearer token,
//! session cookie or PEM key before it ever reaches the webview or a file.
//!
//! **The contract the tests in this file pin.** A line is replaced wholesale by
//! `REDACTED` when it matches, case-insensitively, either:
//!   - a `SECRET_KEYWORDS` fragment anywhere in the line, or
//!   - a JWT (`header.payload.signature`) anywhere in the line.
//!
//! Anything else is returned byte-for-byte. Redaction is deliberately
//! all-or-nothing per line: a partial redaction leaks whatever it kept.
//!
//! **What this filter deliberately does NOT catch**, because the shapes are
//! indistinguishable from data a user legitimately needs in a diagnostic:
//!   - bare hex/base64 digests. A SHA-256 config hash logged by the elevation
//!     broker and a 64-hex session token are the same shape; redacting the
//!     first would gut the elevation diagnostics. This is why the keyword and
//!     JWT rules carry the weight.
//!     The tail is for a human to read, so a lost digest is a real cost.
//!   - the base64 *body* of a PEM block (the `-----BEGIN … PRIVATE KEY-----`
//!     header and any surrounding mention of the key are caught).
//!
//! Over-redaction is the acceptable failure direction: an ordinary line that
//! gets scrubbed costs a little diagnostic detail, a missed secret costs the
//! user their credential.

use std::path::Path;

use tauri::AppHandle;

use crate::paths;
use crate::logging::log_info;
use crate::status::{runtime_status, RuntimeStatus};

/// Fragments that mark a line as carrying credential material, matched
/// case-insensitively as substrings of the whole line.
///
/// Spelled out per separator family rather than as one loose stem, because the
/// obvious stems miss real traffic: `presharedkey` never matches WireGuard's
/// own "pre-shared key", and `bearer ` (with a trailing space) is evaded by a
/// header dump that separates the scheme with a tab.
const SECRET_KEYWORDS: [&str; 19] = [
    // Request/response headers forwarded verbatim when a call fails.
    "authorization",
    "bearer",
    "cookie",
    "set-cookie",
    // Generic credential vocabulary.
    "token",
    "secret",
    "password",
    "passwd",
    "passphrase",
    // Key material. The app installs WireGuard tunnels and holds their keys.
    "private key",
    "presharedkey",
    "preshared key",
    "preshared-key",
    "pre-shared key",
    "pre-shared-key",
    // API keys, which routinely appear with no other marker on the line.
    "api key",
    "api-key",
    "api_key",
    "apikey",
];

/// What a scrubbed line is replaced with. Must itself be inert — see the test
/// that asserts this, so re-reading an exported report cannot cascade.
const REDACTED: &str = "[redacted by diagnostics filter]";

/// Hard cap on how much of the log the tail can pull, whatever the UI asks for.
const MAX_TAIL_LINES: usize = 500;

/// Shortest run treated as a JWT segment. Real header/payload/signature runs are
/// far longer; this keeps dotted hostnames, versions and file names out even
/// before the base64url alphabet check rejects them.
const JWT_SEGMENT_MIN: usize = 10;

/// Characters that end a candidate token. `.` is deliberately absent — it is
/// the JWT's own separator. A raw string keeps this free of escaping.
const JWT_DELIMITERS: &str = r#""'`,;:{}[]()<>/|"#;

/// Does this line carry something that must never reach the webview or an
/// exported file?
fn is_secret(line: &str) -> bool {
    let lower = line.to_lowercase();
    SECRET_KEYWORDS
        .iter()
        .any(|k| lower.contains(k))
        || lower
            .split(|c: char| c.is_whitespace() || JWT_DELIMITERS.contains(c))
            .any(looks_like_jwt)
}

/// `header.payload.signature` — three base64url runs joined by dots.
///
/// A JWT is the canonical shape of a bearer credential and routinely reaches a
/// log with no keyword anywhere near it ("api replied eyJ…"), so keyword
/// matching alone does not catch it. The first segment must start with `eyj`,
/// the base64url of `{"`: every JWT header is JSON, and that anchor is what
/// keeps this from matching dotted identifiers, hostnames, IP addresses,
/// versions or Windows paths (all of which fail here on alphabet, part count
/// or segment length anyway).
fn looks_like_jwt(chunk: &str) -> bool {
    let parts: Vec<&str> = chunk.split('.').collect();
    parts.len() == 3
        && parts[0].starts_with("eyj")
        && parts.iter().all(|p| {
            p.len() >= JWT_SEGMENT_MIN && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// Redact one line, or return it untouched.
fn redact_line(line: &str) -> String {
    if is_secret(line) {
        REDACTED.to_string()
    } else {
        line.to_string()
    }
}

/// The last `lines` lines of `content`, with secret-shaped lines scrubbed.
///
/// Pure: no I/O, no `AppHandle`. This is the level the tests exercise, so the
/// truncation cap and the redaction are covered together rather than only in
/// isolation.
fn redact_tail(content: &str, lines: usize) -> Vec<String> {
    let total = content.lines().count();
    let skip = total.saturating_sub(lines.min(MAX_TAIL_LINES));
    content.lines().skip(skip).map(redact_line).collect()
}

/// Redacted tail of the startup log for the System Health page.
#[tauri::command]
pub fn read_log_tail(app: AppHandle, lines: usize) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(paths::log_file(&app))
        .map_err(|e| format!("cannot read log: {e}"))?;
    Ok(redact_tail(&content, lines))
}

/// Export a diagnostic report (JSON) next to the logs. Contains versions,
/// runtime status, boot-stage journal and the redacted log tail — never
/// secrets: tokens live only in memory, credentials in the data dir are NOT
/// copied, and the log tail passes the same filter as read_log_tail.
#[tauri::command]
pub fn save_diagnostic_report(app: AppHandle) -> Result<String, String> {
    let log_dir = paths::log_dir(&app);
    let status: RuntimeStatus = runtime_status(app.clone());

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
        // `read_log_tail` fails when the log cannot be READ (permissions, a lock)
        // — not the same as a log with nothing in it. `unwrap_or_default()`
        // wrote `"bootLogTail": []` into a support report, which reads as "the
        // app logged nothing"; the truth is that we could not open the log.
        "bootLogTail": tail_field(read_log_tail(app.clone(), 200)),
        "note": "Secrets are never included: daemon tokens are memory-only, VPN credentials/private keys are not copied, and log lines matching secret patterns are redacted."
    });

    let file = Path::new(&log_dir).join(format!("diagnostic-report-{}.json", unix_now()));
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("log dir: {e}"))?;
    std::fs::write(&file, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| format!("cannot write report: {e}"))?;
    log_info!("diagnostic report written: {}", file.display());
    Ok(file.to_string_lossy().to_string())
}

/// The `bootLogTail` field. Absent (`null`) means "the log could not be read";
/// an empty array means "the log was read and had nothing in it". Split out so
/// that difference is pinned directly rather than through a real unreadable log
/// file, which only this machine can arrange.
fn tail_field(tail: Result<Vec<String>, String>) -> serde_json::Value {
    match tail {
        Ok(lines) => serde_json::json!(lines),
        Err(_) => serde_json::Value::Null,
    }
}

/// Unix seconds, or 0 if the clock is before the epoch.
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) mod tests;
