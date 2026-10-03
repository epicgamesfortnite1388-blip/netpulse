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
use crate::sidecar::log_info;
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // ---------------------------------------------------------------------
    // The keyword contract: every declared fragment must scrub its line.
    // ---------------------------------------------------------------------

    #[test]
    fn every_declared_keyword_scrubs_its_line() {
        for keyword in SECRET_KEYWORDS {
            let line = format!("2026-10-04T00:00:00Z INFO upstream replied {keyword}=abc123");
            assert_eq!(
                redact_line(&line),
                REDACTED,
                "a line carrying {keyword:?} was NOT redacted"
            );
        }
    }

    #[test]
    fn keywords_match_case_insensitively() {
        for keyword in SECRET_KEYWORDS {
            let shouted = keyword.to_uppercase();
            assert_eq!(
                redact_line(&shouted),
                REDACTED,
                "{keyword:?} was missed when upper-cased"
            );
        }
    }

    #[test]
    fn a_keyword_is_caught_anywhere_in_the_line_not_just_at_the_start() {
        let line = "2026-10-04T00:00:00Z DEBUG request headers: authorization=Bearer eyJhbGciOiJIUzI1NiJ9";
        assert_eq!(redact_line(line), REDACTED);
    }

    // ---------------------------------------------------------------------
    // Realistic credential shapes. Each of these was a genuine gap in the
    // original nine-pattern list — see the module doc for what is and is not
    // catchable.
    // ---------------------------------------------------------------------

    #[test]
    fn a_realistic_jwt_with_no_keyword_near_it_is_scrubbed() {
        // The canonical jwt.io example token, standing alone on the line: no
        // "token", no "bearer", no "authorization" anywhere near it.
        let line = "2026-10-04T00:00:02Z INFO api replied eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik5ldFB1bHNlIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        assert_eq!(redact_line(line), REDACTED);
    }

    #[test]
    fn a_jwt_embedded_in_json_is_scrubbed() {
        let line = r#"{"status":"200","jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk","latency":42}"#;
        assert_eq!(redact_line(line), REDACTED);
    }

    #[test]
    fn a_bearer_scheme_with_no_space_after_it_is_scrubbed() {
        // The old pattern was "bearer " WITH a trailing space, so a header dump
        // separating the scheme from the credential with a tab — or a line that
        // ends at the scheme — walked straight through. The scheme is not a word
        // that appears in ordinary prose, so matching "bearer" bare is safe.
        for line in [
            "2026-10-04T00:00:01Z DEBUG reply header dump: bearer\teyJhbGciOiJIUzI1NiJ9",
            "2026-10-04T00:00:01Z DEBUG upstream rejected scheme: bearer",
        ] {
            assert_eq!(redact_line(line), REDACTED, "{line:?} leaked a bearer credential");
        }
    }

    #[test]
    fn api_key_assignments_are_scrubbed_in_every_separator_style() {
        for line in [
            "api_key=sk-live-51H8xQzAbCdEfGhIjKlMnOpQr",
            "X-API-Key: sk-live-51H8xQzAbCdEfGhIjKlMnOpQr",
            "apiKey = sk-live-51H8xQzAbCdEfGhIjKlMnOpQr",
            "apikey: sk-live-51H8xQzAbCdEfGhIjKlMnOpQr",
        ] {
            assert_eq!(redact_line(line), REDACTED, "{line:?} leaked an API key");
        }
    }

    #[test]
    fn a_wireguard_preshared_key_is_scrubbed_in_every_spelling() {
        for line in [
            "preshared key = 3f9a2b8c1d4e7f0a6b9c2e5d8f1a4b7c0d3e6f9a2b5c8e1d4f7a0b3c6e9d2f5a",
            "pre-shared-key: 3f9a2b8c1d4e7f0a6b9c2e5d8f1a4b7c0d3e6f9a2b5c8e1d4f7a0b3c6e9d2f5a",
            "Pre-Shared Key 3f9a2b8c1d4e7f0a6b9c2e5d8f1a4b7c0d3e6f9a2b5c8e1d4f7a0b3c6e9d2f5a",
            "presharedkey=3f9a2b8c1d4e7f0a6b9c2e5d8f1a4b7c0d3e6f9a2b5c8e1d4f7a0b3c6e9d2f5a",
        ] {
            assert_eq!(redact_line(line), REDACTED, "{line:?} leaked a PSK");
        }
    }

    #[test]
    fn a_pem_private_key_header_is_scrubbed() {
        for line in [
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "detected a private key in the uploaded profile",
        ] {
            assert_eq!(redact_line(line), REDACTED, "{line:?} leaked key material");
        }
    }

    #[test]
    fn passphrase_and_passwd_lines_are_scrubbed() {
        assert_eq!(redact_line("connect: passphrase=hunter2"), REDACTED);
        assert_eq!(redact_line("config: passwd = hunter2"), REDACTED);
    }

    #[test]
    fn a_session_cookie_line_is_scrubbed() {
        for line in [
            "reply headers: set-cookie: sid=abc123; HttpOnly",
            "reply headers: cookie: sid=abc123",
        ] {
            assert_eq!(redact_line(line), REDACTED, "{line:?} leaked a cookie");
        }
    }

    // ---------------------------------------------------------------------
    // The other half of the contract: ordinary diagnostic content must
    // survive byte-for-byte, or diagnostics stop being worth exporting.
    // ---------------------------------------------------------------------

    /// Taken verbatim from the `log_*!` call sites in this crate. If the filter
    /// starts eating these, it has become useless.
    #[test]
    fn ordinary_startup_lines_survive_intact() {
        let keep = [
            "=== NetPulse desktop starting (v1.1.1) ===",
            "exe: C:\\Program Files\\NetPulse\\netpulse-desktop.exe",
            "WebView2Loader.dll next to exe: true",
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: <not set>",
            "logging initialized (data dir: C:\\Users\\RADIN\\AppData\\Roaming\\app.netpulse.desktop)",
            "data dir: C:\\Users\\RADIN\\AppData\\Roaming\\app.netpulse.desktop",
            "sidecar started (bundled) on port 51423 (startup buffer armed, 40 lines)",
            "sidecar stopped",
            "bootstrap: sidecar answered after 731 ms",
            "main window sized to 1600x900 logical (monitor offers 1920x1040)",
            "main window shown, sized and centered",
            "monitor reported a zero-sized work area; centring the default window size",
            "could not query the monitor; centring the default window size",
            "repair: restarting backend on user request",
            "elevation: launching allowed tunnel install for op op-42",
            "elevation: user declined the prompt for op op-42",
            "admin: helper 8124 armed; quitting for the elevated relaunch",
            "admin: starting the elevated relaunch helper",
            "tray unavailable (app continues without it): the system tray is not available",
            "backend/drizzle not found next to exe; sidecar will rely on NETPULSE_MIGRATIONS_DIR fallback",
            "opening external link for host www.cloudflare.com",
            "diagnostic report written: C:\\Users\\RADIN\\AppData\\Roaming\\app.netpulse.desktop\\logs\\diagnostic-report-1759500000.json",
            "SAFE MODE requested: network stack disabled for this launch",
            "event loop exited",
        ];
        for line in keep {
            assert_eq!(redact_line(line), line, "ordinary line was redacted");
        }
    }

    #[test]
    fn a_sha256_config_hash_survives() {
        // The elevation broker logs config digests and they are the single most
        // useful line in a "why did the tunnel install fail" report. A digest is
        // byte-identical in shape to a hex token, so this is the documented
        // limit of the filter rather than an oversight.
        let line = "elevation: verified config sha256=3f9a2b8c1d4e7f0a6b9c2e5d8f1a4b7c0d3e6f9a2b5c8e1d4f7a0b3c6e9d2f5a";
        assert_eq!(redact_line(line), line);
    }

    #[test]
    fn dotted_identifiers_are_never_mistaken_for_tokens() {
        for line in [
            "peer endpoint: 192.168.1.100",
            "peer endpoint: 2001:db8::1",
            "app version 1.11.1 resolved",
            "resolved s3.eu-central-1.amazonaws.com for the feed",
            "config at C:\\Users\\RADIN\\AppData\\Roaming\\app.netpulse.desktop\\netpulse.db",
            "migrated 12 statements from 0063_solo_and_requests.sql",
            "GET https://www.cloudflare.com/cdn-cgi/trace 200",
        ] {
            assert!(
                !looks_like_jwt(line),
                "{line:?} was misread as a JWT-shaped token"
            );
            assert_eq!(redact_line(line), line, "{line:?} was wrongly redacted");
        }
    }

    #[test]
    fn the_redaction_marker_is_not_itself_secret_shaped() {
        // Re-reading an exported report must not cascade: the marker survives
        // the filter, so a report can be re-exported or pasted into a log.
        assert!(!is_secret(REDACTED));
        assert_eq!(redact_line(REDACTED), REDACTED);
    }

    #[test]
    fn an_empty_line_stays_empty() {
        assert_eq!(redact_line(""), "");
    }

    // ---------------------------------------------------------------------
    // The tail: truncation and its cap, with redaction applied together.
    // ---------------------------------------------------------------------

    #[test]
    fn the_tail_returns_only_the_last_lines_requested() {
        let content = (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        assert_eq!(
            redact_tail(&content, 3),
            vec!["line 8".to_string(), "line 9".into(), "line 10".into()]
        );
    }

    #[test]
    fn the_tail_is_capped_whatever_the_ui_asks_for() {
        let content = (1..=MAX_TAIL_LINES + 50)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(redact_tail(&content, 100_000).len(), MAX_TAIL_LINES);
    }

    #[test]
    fn a_short_log_returns_whole_lines_without_padding() {
        assert_eq!(redact_tail("only line", 200), vec!["only line".to_string()]);
    }

    #[test]
    fn asking_for_zero_lines_returns_nothing() {
        assert!(redact_tail("a\nb\nc", 0).is_empty());
    }

    #[test]
    fn an_empty_log_returns_nothing() {
        assert!(redact_tail("", 200).is_empty());
    }

    #[test]
    fn redacting_never_changes_the_number_of_lines() {
        // The System Health page counts what it was given; a scrub that
        // dropped or duplicated lines would corrupt that.
        let content = "plain\ntoken=abc\nplain again\ncookie: x\n1.2.3\n";
        assert_eq!(redact_tail(content, 100).len(), content.lines().count());
    }

    /// The end-to-end shape of a real boot log: exactly the secret-bearing
    /// lines are replaced and everything else is byte-identical.
    #[test]
    fn a_mixed_boot_log_scrubs_only_the_secret_lines() {
        let content = "\
2026-10-04T00:00:00Z INFO === NetPulse desktop starting (v1.1.1) ===
2026-10-04T00:00:01Z INFO sidecar started (bundled) on port 51423 (startup buffer armed, 40 lines)
2026-10-04T00:00:02Z DEBUG request headers: authorization=Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop
2026-10-04T00:00:03Z INFO upstream returned eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop
2026-10-04T00:00:04Z INFO main window shown, sized and centered
2026-10-04T00:00:05Z DEBUG elevation: verified config sha256=3f9a2b8c1d4e7f0a6b9c2e5d8f1a4b7c0d3e6f9a2b5c8e1d4f7a0b3c6e9d2f5a
2026-10-04T00:00:06Z ERROR sidecar failed to start on first attempt (GUI stays up): EADDRINUSE";
        assert_eq!(
            redact_tail(content, 100),
            vec![
                "2026-10-04T00:00:00Z INFO === NetPulse desktop starting (v1.1.1) ===",
                "2026-10-04T00:00:01Z INFO sidecar started (bundled) on port 51423 (startup buffer armed, 40 lines)",
                REDACTED,
                REDACTED,
                "2026-10-04T00:00:04Z INFO main window shown, sized and centered",
                "2026-10-04T00:00:05Z DEBUG elevation: verified config sha256=3f9a2b8c1d4e7f0a6b9c2e5d8f1a4b7c0d3e6f9a2b5c8e1d4f7a0b3c6e9d2f5a",
                "2026-10-04T00:00:06Z ERROR sidecar failed to start on first attempt (GUI stays up): EADDRINUSE",
            ]
        );
    }
}
