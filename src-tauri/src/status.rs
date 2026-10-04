//! Runtime status of the Rust core + sidecar, polled by the System Health page
//! to build the Starting → Checking → Ready/Degraded/Recovery state machine.
//!
//! This is an aggregator, not an owner: it reads the sidecar, the path
//! resolvers, the safe-mode flag and the window, and composes one snapshot.
//!
//! **The page it feeds is the user looking for what's wrong.** That makes one
//! failure mode worse than any other: inventing good news. A sidecar that is
//! down must not come back with a port, and a sidecar state we could not read
//! must not come back as "0 restarts", which is a real claim — this sidecar
//! has never crashed — that happens to be the most reassuring thing the struct
//! could possibly say. Everything below is arranged so an unreadable input
//! produces an absent one, never a default.
//!
//! The composition is therefore split from the Tauri plumbing: `compose` and
//! `child_is_running` are pure and tested on their own, and `runtime_status`
//! only gathers what to hand them.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::sidecar::SidecarInner;
use crate::{paths, safe_mode, sidecar};

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub sidecar_running: bool,
    /// How many times the sidecar has been respawned this session, or `None`
    /// when that could not be read. Never `0` standing in for "unknown".
    pub sidecar_restarts: Option<u32>,
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
    /// Size of the rotating log, or `None` when it is there but could not be
    /// read. Never `0` standing in for "we could not open it".
    pub log_file_bytes: Option<u64>,
    pub log_rotation_cap_bytes: u64,
}

/// What we managed to observe about the sidecar.
///
/// The whole struct is optional because there are two different kinds of
/// "we don't know": a lock we could not take, and a child we could not query.
/// Only the first makes every field unknown.
struct SidecarFacts {
    running: bool,
    restarts: Option<u32>,
    port: Option<u16>,
    last_reason: Option<String>,
    last_at: Option<u64>,
}

impl SidecarFacts {
    /// Everything we may honestly claim when the sidecar state could not be
    /// read at all.
    fn unknown() -> Self {
        SidecarFacts {
            running: false,
            restarts: None,
            port: None,
            last_reason: None,
            last_at: None,
        }
    }
}

/// Is this child still up? `None` means never spawned, or already reaped.
///
/// `try_wait` is the only honest source for this. A `Child` handle stays
/// `Some` after its process has exited, so `is_some()` would call a sidecar
/// that died ten minutes ago "running". An error from `try_wait` means we do
/// not know, and the honest direction for "running" is false — a page that
/// says "unknown" would have to be trusted, and a page that says "not running"
/// sends the user to the logs.
fn child_is_running(child: Option<&mut std::process::Child>) -> bool {
    child
        .and_then(|c| c.try_wait().ok())
        .map(|status| status.is_none())
        .unwrap_or(false)
}

/// Read the sidecar out of its own state.
///
/// Free of `AppHandle` so the mapping below is testable against real values
/// rather than only against a running app.
fn observe(inner: &mut SidecarInner) -> SidecarFacts {
    SidecarFacts {
        running: child_is_running(inner.child.as_mut()),
        restarts: Some(inner.restarts),
        // The port we reserved, reported raw. Whether it may be PUBLISHED is
        // `compose`'s decision — see there.
        port: Some(inner.port),
        last_reason: inner.last_restart_reason.clone(),
        last_at: inner.last_restart_at_unix,
    }
}

/// Build the snapshot from what we observed.
///
/// `facts` is `None` when the sidecar lock could not be taken at all, and
/// every field then degrades to "unknown" rather than to a plausible number.
fn compose(
    facts: Option<SidecarFacts>,
    safe_mode: bool,
    window_visible: bool,
    data_dir: String,
    log_dir: String,
    log_file_bytes: Option<u64>,
) -> RuntimeStatus {
    let SidecarFacts {
        running,
        restarts,
        port,
        last_reason,
        last_at,
    } = facts.unwrap_or_else(SidecarFacts::unknown);

    RuntimeStatus {
        sidecar_running: running,
        sidecar_restarts: restarts,
        // Published only while something is actually listening on it. The
        // reserved port outlives the process, so reporting it for a dead
        // sidecar would tell the user where to connect to a backend that is
        // not there — the same class of lie as a zero restart count.
        sidecar_port: if running { port } else { None },
        last_restart_reason: last_reason,
        last_restart_at_unix: last_at,
        safe_mode,
        window_visible,
        data_dir,
        log_dir,
        log_file_bytes,
        log_rotation_cap_bytes: crate::logging::LOG_CAP_BYTES,
    }
}

#[tauri::command]
pub fn runtime_status(app: AppHandle) -> RuntimeStatus {
    let facts = {
        let state = app.state::<sidecar::SidecarState>();
        state.inner.lock().ok().map(|mut inner| observe(&mut inner))
    };
    compose(
        facts,
        safe_mode::is_active(&app),
        app.get_webview_window("main")
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false),
        paths::data_dir(&app),
        paths::log_dir(&app),
        paths::log_file_bytes(&app),
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Everything below drives `compose`, because that is where every honesty rule
// lives: what we are ALLOWED to publish. `runtime_status` itself only gathers
// inputs, and the IPC gate drives it against a real running app.

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(running: bool, restarts: Option<u32>, port: Option<u16>) -> SidecarFacts {
        SidecarFacts {
            running,
            restarts,
            port,
            last_reason: None,
            last_at: None,
        }
    }

    fn snapshot(facts: Option<SidecarFacts>) -> RuntimeStatus {
        compose(
            facts,
            false,
            true,
            "C:\\data".into(),
            "C:\\data\\logs".into(),
            Some(4096),
        )
    }

    // ----------------------------------------------------------------------
    // Not inventing a port for a sidecar that is not there
    // ----------------------------------------------------------------------

    #[test]
    fn a_sidecar_that_is_not_running_is_never_published_with_a_port() {
        // The port we reserved outlives the process, so it is sitting right
        // there in the state. Publishing it would have the System Health page
        // point a user at a backend that is not listening.
        let s = snapshot(Some(facts(false, Some(3), Some(47_615))));
        assert!(!s.sidecar_running);
        assert_eq!(
            s.sidecar_port, None,
            "a dead sidecar must not be reported with a port"
        );
    }

    #[test]
    fn a_running_sidecar_publishes_the_port_it_reserved() {
        let s = snapshot(Some(facts(true, Some(0), Some(47_615))));
        assert!(s.sidecar_running);
        assert_eq!(s.sidecar_port, Some(47_615));
    }

    #[test]
    fn a_running_sidecar_that_reserved_an_ephemeral_port_still_publishes_it() {
        let s = snapshot(Some(facts(true, Some(0), Some(51_233))));
        assert_eq!(s.sidecar_port, Some(51_233));
    }

    // ----------------------------------------------------------------------
    // Not inventing a restart count
    // ----------------------------------------------------------------------

    #[test]
    fn an_unreadable_sidecar_state_reports_unknown_rather_than_a_healthy_zero() {
        let s = snapshot(None);
        assert!(!s.sidecar_running, "unknown must not read as running");
        assert_eq!(
            s.sidecar_restarts, None,
            "0 would claim the sidecar has never crashed — the most \
             reassuring thing this struct could say, and exactly what we \
             do not know"
        );
        assert_eq!(s.sidecar_port, None);
        assert_eq!(s.last_restart_reason, None);
        assert_eq!(s.last_restart_at_unix, None);
    }

    #[test]
    fn a_sidecar_that_truly_never_restarted_reports_zero_and_not_null() {
        // The other half of the contract: a known zero is real information
        // and must not be flattened into "unknown" alongside a genuine one.
        let s = snapshot(Some(facts(true, Some(0), Some(47_615))));
        assert_eq!(s.sidecar_restarts, Some(0));
    }

    #[test]
    fn degrading_the_port_does_not_discard_the_restart_history_we_really_have() {
        // A dead sidecar is a normal state, not a reason to blank the page:
        // the restart count and the reason it died are exactly what the user
        // came here to read.
        let mut f = facts(false, Some(4), Some(47_615));
        f.last_reason = Some("exit code 1: refused to bind".into());
        f.last_at = Some(1_700_000_000);
        let s = snapshot(Some(f));
        assert!(!s.sidecar_running);
        assert_eq!(s.sidecar_port, None);
        assert_eq!(s.sidecar_restarts, Some(4));
        assert_eq!(
            s.last_restart_reason.as_deref(),
            Some("exit code 1: refused to bind")
        );
        assert_eq!(s.last_restart_at_unix, Some(1_700_000_000));
    }

    #[test]
    fn a_restart_reason_is_never_invented_for_a_sidecar_that_never_died() {
        let mut f = facts(true, Some(0), Some(47_615));
        f.last_reason = None;
        let s = snapshot(Some(f));
        assert_eq!(s.last_restart_reason, None);
        assert_eq!(s.last_restart_at_unix, None);
    }

    // ----------------------------------------------------------------------
    // The IPC shape — the frontend reads these fields by name
    // ----------------------------------------------------------------------

    #[test]
    fn an_unknown_restart_count_serializes_as_null_never_as_zero() {
        // Pins the wire format. The TypeScript interface types these as
        // `number | null`, so a silent change to `0` would typecheck on the
        // Rust side and lie in the UI on the other. The log size is passed
        // explicitly rather than through `snapshot`, because `snapshot(None)`
        // says the SIDECAR facts are unknown, not that the log is unreadable.
        let unknown = serde_json::to_value(compose(
            None,
            false,
            true,
            "C:\\data".into(),
            "C:\\data\\logs".into(),
            None,
        ))
        .expect("serialize");
        assert!(unknown["sidecar_restarts"].is_null());
        assert_eq!(unknown["sidecar_running"], serde_json::json!(false));
        assert!(
            unknown["log_file_bytes"].is_null(),
            "an unreadable log must serialize as null, not as 0 bytes"
        );

        let healthy = serde_json::to_value(snapshot(Some(facts(true, Some(0), Some(47_615)))))
            .expect("serialize");
        assert_eq!(healthy["sidecar_restarts"], serde_json::json!(0));
        assert_eq!(healthy["sidecar_port"], serde_json::json!(47_615));
        assert_eq!(healthy["log_file_bytes"], serde_json::json!(4096));
    }

    #[test]
    fn a_stopped_sidecar_serializes_its_port_as_null() {
        let v = serde_json::to_value(snapshot(Some(facts(false, Some(1), Some(47_615)))))
            .expect("serialize");
        assert!(v["sidecar_port"].is_null());
    }

    #[test]
    fn the_snapshot_carries_through_the_paths_safe_mode_and_window_it_was_given() {
        let s = compose(
            Some(facts(true, Some(2), Some(47_615))),
            true,
            false,
            "C:\\Users\\x\\NetPulse".into(),
            "C:\\Users\\x\\NetPulse\\logs".into(),
            Some(12_288),
        );
        assert!(s.safe_mode, "Safe Mode must be reported as ACTIVE");
        assert!(!s.window_visible);
        assert_eq!(s.data_dir, "C:\\Users\\x\\NetPulse");
        assert_eq!(s.log_dir, "C:\\Users\\x\\NetPulse\\logs");
        assert_eq!(s.log_file_bytes, Some(12_288));
    }

    #[test]
    fn a_window_that_could_not_be_read_is_reported_not_visible() {
        // `is_visible()` errors and a missing window both land here. False is
        // the direction that makes the user look, rather than the direction
        // that reassures them.
        let s = compose(
            None,
            false,
            false,
            "C:\\data".into(),
            "C:\\data\\logs".into(),
            Some(0),
        );
        assert!(!s.window_visible);
    }

    #[test]
    fn an_unreadable_log_is_carried_through_as_unavailable_not_as_zero() {
        // `paths::file_size` distinguishes a fresh install (Some(0), a real
        // measurement) from a log it could not stat (None). The page must be
        // able to tell those apart, or "we could not read it" is displayed as
        // the most reassuring thing the row can say.
        let unreadable = compose(
            Some(facts(true, Some(0), Some(47_615))),
            false,
            true,
            "C:\\data".into(),
            "C:\\data\\logs".into(),
            None,
        );
        assert_eq!(unreadable.log_file_bytes, None);

        let fresh_install = compose(
            Some(facts(true, Some(0), Some(47_615))),
            false,
            true,
            "C:\\data".into(),
            "C:\\data\\logs".into(),
            Some(0),
        );
        assert_eq!(fresh_install.log_file_bytes, Some(0));
    }

    #[test]
    fn the_rotation_cap_the_snapshot_advertises_is_the_writers_real_cap() {
        // The System Health page renders "size / cap" from these two numbers.
        // If they came from different places the page would show a ratio that
        // is simply false.
        let s = snapshot(None);
        assert_eq!(s.log_rotation_cap_bytes, crate::logging::LOG_CAP_BYTES);
    }

    // ----------------------------------------------------------------------
    // Reading a real child
    // ----------------------------------------------------------------------

    #[test]
    fn no_child_is_never_reported_running() {
        assert!(!child_is_running(None));
    }

    #[test]
    fn an_exited_child_is_not_reported_running_even_though_its_handle_survives() {
        // The trap this guards: `child.is_some()` is still true here, so any
        // implementation that used it would call a dead sidecar running.
        let mut child = std::process::Command::new(std::env::current_exe().expect("test exe"))
            .args(["--list", "zzz_no_such_test_name"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn");
        child.wait().expect("wait");
        assert!(
            !child_is_running(Some(&mut child)),
            "a reaped child must not read as running, even though the \
             handle is still Some"
        );
    }
}