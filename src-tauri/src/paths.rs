//! Where the app's files live — the ONE resolver for both directories.
//!
//! These were previously resolved independently in three places (the `setup`
//! hook, the `data_paths` command and `reset_app_state`), which is exactly the
//! shape of bug where the System Health page reports a path nothing writes to.
//!
//! The trap this module exists to prevent: the rotating diagnostic log lives
//! under the app DATA dir (`<data>/logs`, created by `logging::init_logging`
//! before the Tauri app exists), NOT under Tauri's `app_log_dir()`, which
//! resolves to LocalAppData on Windows while `app_data_dir()` resolves to
//! AppData\Roaming. Every reader of the log goes through `log_dir` below.
//!
//! Two things here are load-bearing and easy to break silently, so each is
//! pinned by a test rather than by a comment:
//!   - `APP_IDENTIFIER` must equal `identifier` in tauri.conf.json. Tauri
//!     derives `%APPDATA%\<identifier>` from that file and we cannot read it
//!     at compile time. If they drift, the handle-free resolver — the one that
//!     CREATES the log directory, before any AppHandle exists — and Tauri's
//!     resolver — the one everything else READS — point at different places,
//!     and every consumer stays green while reading the wrong root.
//!   - `LOG_SUBDIR` is also what `logging::init_logging` writes to, because it
//!     calls `log_dir_in` rather than repeating `join("logs")`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Tauri's `identifier`, duplicated from tauri.conf.json (see module docs).
const APP_IDENTIFIER: &str = "app.netpulse.desktop";

/// Subdirectory of the data dir holding the rotating log.
const LOG_SUBDIR: &str = "logs";

/// File name of the rotating log, shared by the writer and every reader.
const LOG_FILE_NAME: &str = "netpulse.log";

/// What we report when no data dir can be resolved at all.
///
/// Deliberately relative, not absolute: it is handed to the sidecar as
/// `NETPULSE_DATA_DIR` and used as a display string, so "." keeps the backend
/// inside the process's own directory instead of pointing it at some unrelated
/// system location that merely happens to be readable.
const UNRESOLVED: &str = ".";

/// Tauri's app_data_dir for our identifier, resolved WITHOUT an AppHandle:
/// %APPDATA%\<identifier> (roaming), matching `tauri::PathResolver` on Windows.
///
/// Needed by code that runs before the Tauri app exists (logging init) and as
/// the fallback for every later reader.
///
/// An EMPTY `APPDATA` is treated as absent. `PathBuf::from("").join(id)` yields
/// a bare relative `app.netpulse.desktop`, so accepting it would silently
/// retarget the whole app at the process's current directory — a wrong root
/// that still produces a green run.
pub fn data_dir_without_handle() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(APP_IDENTIFIER))
}

/// The app data dir (database, logs, caches) as a path.
///
/// Resolves through Tauri first, then the handle-free mirror above. `None` only
/// when the OS refuses to resolve either.
pub fn data_dir_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .or_else(data_dir_without_handle)
}

/// The app data dir as a string, falling back to "." the way the env var the
/// sidecar reads (`NETPULSE_DATA_DIR`) always needs.
pub fn data_dir(app: &AppHandle) -> String {
    data_dir_path(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| UNRESOLVED.to_string())
}

/// Same as `data_dir_path`, but for callers that must refuse rather than guess
/// (anything about to move or delete files).
pub fn require_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))
        .or_else(|e| data_dir_without_handle().ok_or(e))
}

/// `<data>/logs` for an already-resolved data dir.
///
/// The single definition of that subdirectory: `logging::init_logging`, which
/// creates the directory the log is written into, calls this rather than
/// repeating the name, so the writer and every reader cannot drift apart.
pub fn log_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join(LOG_SUBDIR)
}

/// The log directory for a resolved data dir, or "." when there is none.
///
/// There is no second chance to resolve the data dir here: `data_dir_path`
/// already tried Tauri and the handle-free mirror, so a `None` reaching this
/// function means neither worked. It used to retry the mirror anyway, which
/// could only ever produce the same `None`.
fn resolve_log_dir(data_dir: Option<PathBuf>) -> String {
    match data_dir {
        Some(data) => log_dir_in(&data).to_string_lossy().to_string(),
        None => UNRESOLVED.to_string(),
    }
}

/// `<data>/logs` — where `logging::init_logging` actually writes netpulse.log.
pub fn log_dir(app: &AppHandle) -> String {
    resolve_log_dir(data_dir_path(app))
}

/// The rotating log file inside a given log directory.
pub fn log_file_in(log_dir: &Path) -> PathBuf {
    log_dir.join(LOG_FILE_NAME)
}

/// Path of the rotating log file itself.
pub fn log_file(app: &AppHandle) -> PathBuf {
    log_file_in(Path::new(&log_dir(app)))
}

/// Size of a log file.
///
/// Three cases, and the caller has to be able to tell them apart:
///   - `Some(n)` — the file is there and this is how big it is.
///   - `Some(0)` — there is no file yet. On a fresh install that is a real
///     measurement, not a failure: nothing has been logged because nothing
///     has run.
///   - `None`    — there IS a file and we could not measure it. A permissions
///     problem, a lock, a path we cannot stat. This is emphatically not zero:
///     reporting it as zero tells the user their log is empty when the truth
///     is that we could not read it, which is the most reassuring possible
///     reading of the one field on the System Health page that exists to say
///     what is wrong.
pub fn file_size(path: &Path) -> Option<u64> {
    size_from_metadata(std::fs::metadata(path))
}

/// Classify a `metadata` outcome, so the three cases above are decided in
/// exactly one place. Split out because only this process can provoke a
/// genuine "present but unreadable", so the branch is pinned directly rather
/// than through the filesystem.
fn size_from_metadata(res: std::io::Result<std::fs::Metadata>) -> Option<u64> {
    match res {
        Ok(m) => Some(m.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(0),
        Err(_) => None,
    }
}

/// Current size of the rotating log. See `file_size` for what `None` means.
pub fn log_file_bytes(app: &AppHandle) -> Option<u64> {
    file_size(&log_file(app))
}

/// Native application-data directory for the backend, exposed to the UI (About
/// screen, log viewer) and diagnostics.
#[derive(Serialize)]
pub struct DataPaths {
    pub data_dir: String,
    pub log_dir: String,
}

#[tauri::command]
pub fn data_paths(app: AppHandle) -> DataPaths {
    DataPaths {
        data_dir: data_dir(&app),
        log_dir: log_dir(&app),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// `data_dir_without_handle` reads the process environment, and the test
    /// binary runs tests in parallel, so every case that touches APPDATA holds
    /// this. A poisoned lock means another env test panicked; continuing with
    /// the guard is the same choice `bootstrap` makes for the sidecar state.
    fn env_guard() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Runs `body` with APPDATA set to `value`, restoring the real one after.
    ///
    /// `pub(crate)` because `os_open`'s handoff-record tests need a scratch
    /// profile too, and the environment is process-wide: the value they point
    /// APPDATA at is what decides whether a fallback write would land somewhere
    /// real, so those cases must hold this same lock while they run.
    pub(crate) fn with_appdata(value: Option<&str>, body: impl FnOnce()) {
        let _guard = env_guard();
        let previous = std::env::var_os("APPDATA");
        // SAFETY of the intent: single-threaded here because of env_guard.
        match value {
            Some(v) => std::env::set_var("APPDATA", v),
            None => std::env::remove_var("APPDATA"),
        }
        body();
        match previous {
            Some(v) => std::env::set_var("APPDATA", v),
            None => std::env::remove_var("APPDATA"),
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("np-paths-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    // ------------------------------------------------------------------
    // The handle-free branch. This app ships on Windows, so %APPDATA% is the
    // real input; the "unset" case below is the same code path a non-Windows
    // build takes, exercised here rather than on another machine.
    // ------------------------------------------------------------------

    #[test]
    fn the_handle_free_data_dir_is_appdata_plus_the_identifier() {
        let base = scratch("appdata");
        let expected = base.join(APP_IDENTIFIER);
        with_appdata(Some(&base.to_string_lossy()), || {
            assert_eq!(data_dir_without_handle(), Some(expected.clone()));
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_handle_free_data_dir_is_absolute_when_appdata_is_set() {
        let base = scratch("absolute");
        with_appdata(Some(&base.to_string_lossy()), || {
            let resolved = data_dir_without_handle().expect("set APPDATA resolves");
            assert!(resolved.is_absolute(), "{resolved:?} is not absolute");
            assert!(resolved.starts_with(&base));
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The non-Windows branch: no APPDATA, so there is no handle-free answer
    /// and callers fall back to Tauri or to ".".
    #[test]
    fn an_absent_appdata_yields_no_handle_free_data_dir() {
        with_appdata(None, || {
            assert_eq!(
                data_dir_without_handle(),
                None,
                "an absent APPDATA must not resolve to anything"
            );
        });
    }

    /// Regression: an empty APPDATA used to join onto an empty path and yield a
    /// bare relative `app.netpulse.desktop`, silently retargeting the app at
    /// the process's current directory.
    #[test]
    fn an_empty_appdata_is_treated_as_absent_not_as_a_relative_path() {
        with_appdata(Some(""), || {
            assert_eq!(
                data_dir_without_handle(),
                None,
                "an empty APPDATA must not resolve to a relative directory"
            );
        });
    }

    /// The identifier is duplicated from tauri.conf.json because it cannot be
    /// read at compile time. If those two drift, the pre-AppHandle resolver
    /// (which CREATES the log dir) and Tauri's resolver (which everything
    /// READS) name different directories and every gate stays green.
    #[test]
    fn the_identifier_matches_the_one_tauri_resolves_from() {
        let conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let text = std::fs::read_to_string(&conf)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", conf.display()));
        let identifier = text
            .lines()
            .find_map(|line| line.trim().strip_prefix("\"identifier\""))
            .map(|rest| {
                rest.trim_start_matches(':')
                    .trim()
                    .trim_end_matches(',')
                    .trim()
                    .trim_matches('"')
                    .to_string()
            })
            .expect("tauri.conf.json declares an identifier");
        assert_eq!(
            identifier, APP_IDENTIFIER,
            "paths.rs APP_IDENTIFIER has drifted from tauri.conf.json — the log \
             would be written to one directory and read from another"
        );
    }

    // ------------------------------------------------------------------
    // Log directory derivation — pure, so it runs everywhere.
    // ------------------------------------------------------------------

    #[test]
    fn the_log_dir_is_the_logs_subdirectory_of_the_data_dir() {
        let base = scratch("derive");
        let data = base.join("app.netpulse.desktop");
        assert_eq!(log_dir_in(&data), data.join("logs"));
        // Derived FROM the data dir, never from a sibling or a parent.
        assert!(log_dir_in(&data).starts_with(&data));
        assert_ne!(log_dir_in(&data), data);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_log_dir_is_not_derived_from_the_data_dir_itself() {
        // Guards the exact confusion this module documents: the log lives in
        // <data>/logs, NOT in Tauri's app_log_dir (LocalAppData on Windows).
        let data = PathBuf::from("/tmp/app.netpulse.desktop");
        let log = log_dir_in(&data);
        assert_eq!(log.parent().expect("has a parent"), data.as_path());
        assert_eq!(log.file_name().expect("has a leaf"), "logs");
    }

    #[test]
    fn the_resolved_log_dir_of_a_real_data_dir_is_that_data_dir_plus_logs() {
        let base = scratch("resolve");
        let data = base.join("app.netpulse.desktop");
        assert_eq!(resolve_log_dir(Some(data.clone())), data.join("logs").to_string_lossy().to_string());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// With no data dir there is nothing to derive from, and the old code
    /// retried the handle-free resolver here even though `data_dir_path` had
    /// already tried it. It now degrades once, to ".".
    #[test]
    fn an_unresolved_data_dir_degrades_to_a_dot() {
        assert_eq!(resolve_log_dir(None), ".");
        assert!(
            !Path::new(".").join("logs").is_absolute(),
            "the fallback must stay relative, never point at a system location"
        );
    }

    // ------------------------------------------------------------------
    // Existence: the reader must report 0 for a log that is not there yet,
    // which is the normal state on a fresh profile before the first write.
    // ------------------------------------------------------------------

    #[test]
    fn the_log_file_is_netpulse_log_inside_the_log_dir() {
        let base = scratch("logfile");
        let log_dir = log_dir_in(&base);
        assert_eq!(log_file_in(&log_dir), log_dir.join("netpulse.log"));
        assert_eq!(log_file_in(&log_dir).parent(), Some(log_dir.as_path()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_log_size_is_zero_when_the_log_does_not_exist_yet() {
        let base = scratch("absent");
        let missing = log_file_in(&log_dir_in(&base));
        assert!(!missing.exists());
        assert_eq!(
            file_size(&missing),
            Some(0),
            "a missing log is genuinely zero bytes, and must stay distinguishable \
             from a log we could not read"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_log_size_is_the_file_length_once_the_log_exists() {
        let base = scratch("present");
        let log_dir = log_dir_in(&base);
        std::fs::create_dir_all(&log_dir).expect("log dir");
        let file = log_file_in(&log_dir);
        let body = "boot line one\nboot line two\n";
        std::fs::write(&file, body).expect("write log");
        assert_eq!(file_size(&file), Some(body.len() as u64));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_log_dir_that_does_not_exist_yet_still_yields_a_usable_path() {
        // First run: `init_logging` has not created anything, but the resolver
        // must still return the path the writer WILL use.
        let base = scratch("firstrun");
        let log_dir = log_dir_in(&base.join("app.netpulse.desktop"));
        assert!(!log_dir.exists(), "precondition: nothing created yet");
        assert!(log_dir.ends_with("logs"));
        assert_eq!(file_size(&log_file_in(&log_dir)), Some(0));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_log_that_cannot_be_read_is_not_reported_as_zero_bytes() {
        // The case the page would otherwise render as "0 bytes", which on the
        // System Health page reads as "everything is fine". Two different
        // ways to be unable to read a file that is there.
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(size_from_metadata(Err(denied)), None);
        // Raw 32 is ERROR_SHARING_VIOLATION on Windows: the sidecar's log is
        // there, we simply cannot stat it right now. Any non-NotFound error
        // means the same thing, whatever the platform calls it.
        let locked = std::io::Error::from_raw_os_error(32);
        assert_eq!(size_from_metadata(Err(locked)), None);
    }

    #[test]
    fn only_a_genuinely_absent_log_reads_as_zero() {
        let not_found = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(
            size_from_metadata(Err(not_found)),
            Some(0),
            "no file yet is a real measurement of an empty log"
        );
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::InvalidData,
        ] {
            let err = std::io::Error::from(kind);
            assert_eq!(
                size_from_metadata(Err(err)),
                None,
                "{kind:?} is not an absent file and must not become 0 bytes"
            );
        }
    }
}
