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

// ---------------------------------------------------------------------------
// The report must not claim an empty log it could not read.
// ---------------------------------------------------------------------------

#[test]
fn an_unreadable_log_is_reported_as_absent_not_as_an_empty_tail() {
    // The report is the artifact a user sends for support. `[]` in it reads as
    // "the app logged nothing", which is the opposite of what a permissions
    // failure or a locked log file means.
    assert!(
        tail_field(Err("cannot read log: access denied".into())).is_null(),
        "a log we could not read must not be written as an empty tail"
    );
}

#[test]
fn a_readable_log_still_reports_a_real_empty_tail_as_empty() {
    // The other direction, which matters just as much: a log that exists and
    // simply has nothing in it is empty. Collapsing that into null would hide
    // a real symptom (the app logged nothing) behind "unavailable".
    assert_eq!(tail_field(Ok(vec![])), serde_json::json!([]));
    assert_eq!(
        tail_field(Ok(vec!["one line".to_string()])),
        serde_json::json!(["one line"])
    );
}
