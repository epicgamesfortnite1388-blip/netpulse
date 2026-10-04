//! The logging facade: every diagnostic line in the desktop app passes
//! through `write_log`, which mirrors to stderr and, once `init_logging` has
//! named a file, to the rotating log the user can attach to a bug report.
//!
//! This is the ONLY owner of that file. Where it lives belongs to `paths`;
//! what is stripped out of it before it reaches the UI or an exported report
//! belongs to `diagnostics`. Neither needs this module, and none of them may
//! write to the log directly — that is how the writer and the readers drifted
//! apart in the first place.
//!
//! A release build is `windows_subsystem="windows"`, so there is no console to
//! print to: startup failures are invisible unless they reach the file.
//!
//! **A line is the unit of safety here.** `diagnostics::redact_line` is
//! all-or-nothing PER LINE — it drops a line carrying a keyword or a JWT and
//! returns everything else byte-for-byte, because a partial redaction leaks
//! whatever it kept. That only works if a line on disk is a whole line. If
//! two writes could interleave halves, a bearer token could be split across a
//! boundary and read back as two innocuous lines that match no rule at all.
//! So `write_log` formats into one buffer and appends it under one lock, and
//! rotation moves the entire file rather than truncating it: a reader can
//! never be handed half a secret by either route.

use std::fs::{File, OpenOptions};
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Logging facade — eprintln in dev, always mirrored to a rotating log file in
// the app data dir once logging is initialized. Startup failures MUST be
// visible somewhere the user can find them (a console window does not exist in
// a windows_subsystem="windows" release build).
// ---------------------------------------------------------------------------

static LOG_FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

/// Held across the whole append, not just the write, so two writers cannot
/// interleave pieces of two lines. Uncontended cost is one atomic op.
static LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn init_logging(data_dir: &str) {
    // The same resolver every reader uses, so the directory we CREATE is by
    // construction the directory `paths::log_dir` reports.
    let dir = crate::paths::log_dir_in(std::path::Path::new(data_dir));
    let _ = std::fs::create_dir_all(&dir);
    // Rotate: keep the previous file as .log.1, cap size at ~1 MB.
    let path = dir.join("netpulse.log");
    rotate_if_over_cap(&path, LOG_CAP_BYTES);
    LOG_FILE.set(Some(path)).ok();
    log_info!("logging initialized (data dir: {data_dir})");
}

/// Move `path` aside to `path.1` when it is strictly larger than `cap`.
/// Returns whether a rotation happened.
///
/// The WHOLE file moves. That is the point: `rename` cannot land in the
/// middle of a line, so the rotation boundary is always a line boundary and
/// `diagnostics` is never handed a partial line from it. Truncating to the
/// cap would have been cheaper on disk and would have been the one way this
/// module could split a secret.
fn rotate_if_over_cap(path: &Path, cap: u64) -> bool {
    // A missing file reads as 0 bytes, which is under the cap either way.
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size <= cap {
        return false;
    }
    let Some(name) = path.file_name() else {
        return false;
    };
    let mut archived = name.to_os_string();
    archived.push(".1");
    std::fs::rename(path, path.with_file_name(archived)).is_ok()
}

pub fn write_log(level: &str, msg: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
    eprintln!("[netpulse:{level}] {msg}");
    if let Some(Some(path)) = LOG_FILE.get() {
        // One buffer, one locked append. Formatting straight into the file
        // would emit the timestamp, the seq, the level and the message as
        // separate writes, and another writer could land between any two of
        // them: measured, that produced lines like
        // `1791080006 1  [info] [] 1791080006info …`.
        append_line(path, &format!("{ts} {seq} [{level}] {msg}\n"));
    }
}

/// Append one already-formatted line, newline included, as one unit.
fn append_line(path: &Path, line: &str) {
    let _guard = LOG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut f) = open_log(path) else {
        return;
    };
    let _ = f.write_all(line.as_bytes());
}

/// Open the log for appending, recreating its directory if that directory has
/// gone missing.
///
/// There is no second chance to re-point the sink — it is a `OnceLock` that
/// `init_logging` sets once — so if the directory disappears under a running
/// app (`reset_app_state` clears app state; anything tidying `%LOCALAPPDATA%`
/// clears it too) and this returned `None`, every subsequent line would be
/// lost for the rest of the session, with no console to fall back on. The
/// first `open` failing is proof enough that the directory is the problem, so
/// pay for exactly one retry rather than a stat per line.
fn open_log(path: &Path) -> Option<File> {
    let open = || OpenOptions::new().create(true).append(true).open(path);
    match open() {
        Ok(f) => Some(f),
        Err(_) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            open().ok()
        }
    }
}

macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logging::write_log("info", &format!($($arg)*)) };
}
#[allow(unused_macros)]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logging::write_log("warn", &format!($($arg)*)) };
}
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::logging::write_log("error", &format!($($arg)*)) };
}

pub(crate) use log_error;
pub(crate) use log_info;
pub(crate) use log_warn;

/// Install a panic hook that records panics into the same log file. A panic
/// during startup previously vanished (no console in release); now it lands
/// in %APPDATA%/app.netpulse.desktop/logs/netpulse.log.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // `{info}` renders across two physical lines -- location, then
        // message -- which would break this module's own invariant that a
        // write is exactly one line, and would let a panic payload carrying
        // newlines forge extra entries in the log. Flatten it; nothing is lost.
        let rendered = info.to_string().replace(['\r', '\n'], " ");
        log_error!("PANIC: {rendered}");
        default(info);
    }));
}

/// Hard cap for the rotating startup log (~512 KB, two files total). Public so
/// runtime_status can surface the limit on the System Health page.
pub const LOG_CAP_BYTES: u64 = 512 * 1024;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// **Why these exist.** `diagnostics::redact_line` is deliberately
// all-or-nothing PER LINE: a partial redaction leaks whatever it kept. That
// makes this writer's line atomicity a security control rather than a
// tidiness concern, so the tests below assert the guarantees the readers
// actually rely on, not just that something was written.
//
// Tests split two ways. Anything that must exercise the real `write_log`
// goes through `with_global_sink`: `LOG_FILE` is a `OnceLock`, so the sink
// is process-global and can only point at one place for the whole test
// binary. Anything that needs its own directory — rotation, the cap
// boundary, a missing directory — drives `append_line` / `rotate_if_over_cap`
// with an explicit path instead.
//
// Because that sink is process-wide, EVERY other test in this binary writes
// to the same file, in parallel, while these tests hold the window. So none
// of them counts lines: each one keys off a marker unique to its own writes
// and ignores anything else. That does not weaken them. A damaged line can
// no longer match its own marker and pattern, so an interleaved write still
// drops the count below what it should be — which is the failure being
// looked for.

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex;

    static GLOBAL: Mutex<()> = Mutex::new(());
    static SHARED: OnceLock<PathBuf> = OnceLock::new();

    const CONC_THREADS: usize = 12;
    const CONC_PER_THREAD: usize = 40;
    /// Long enough that one line spans several writes, which is what let two
    /// writers share a line before the buffer was built first.
    const CONC_PAD: usize = 1500;

    fn scratch(_tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "netpulse-logtest-{}-{}",
            std::process::id(),
            N.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    /// Run `body` against the process-wide sink, excluding every other test
    /// that also touches it.
    fn with_global_sink<T>(body: impl FnOnce(&Path) -> T) -> T {
        let _guard = GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let path = SHARED
            .get_or_init(|| {
                let data = scratch("shared");
                init_logging(data.to_str().expect("utf-8 temp path"));
                data.join("logs").join("netpulse.log")
            })
            .clone();
        body(&path)
    }

    /// Everything appended since `before` was read. The log is append-only,
    /// so a byte-length slice is exact.
    fn appended_since(path: &Path, before: &str) -> String {
        read(path)[before.len()..].to_string()
    }

    /// Parse `{ts} {seq} [{level}] {msg}`, returning `(level, msg)`.
    fn split_line(line: &str) -> (&str, &str) {
        let (head, msg) = line
            .split_once("] ")
            .unwrap_or_else(|| panic!("line is not in the agreed format: {line:?}"));
        let mut fields = head.split(' ');
        let ts = fields.next().unwrap_or_default();
        let seq = fields.next().unwrap_or_default();
        assert!(
            ts.bytes().all(|b| b.is_ascii_digit()) && !ts.is_empty(),
            "ts is not a plain integer: {line:?}"
        );
        assert!(
            seq.bytes().all(|b| b.is_ascii_digit()) && !seq.is_empty(),
            "seq is not a plain integer: {line:?}"
        );
        let level = fields.next().unwrap_or_default().trim_start_matches('[');
        assert!(
            fields.next().is_none(),
            "the header has extra fields, so writes merged: {line:?}"
        );
        (level, msg)
    }

    // ----------------------------------------------------------------------
    // The line format
    // ----------------------------------------------------------------------

    #[test]
    fn a_written_line_lands_in_the_file_with_the_expected_content() {
        with_global_sink(|path| {
            let before = read(path);
            log_info!("boot sequence marker one");
            log_warn!("boot sequence marker two");
            log_error!("boot sequence marker three");
            let added = appended_since(path, &before);
            let mine: Vec<&str> = added
                .lines()
                .filter(|l| l.contains("boot sequence marker"))
                .collect();
            assert_eq!(
                mine.len(),
                3,
                "one write must produce exactly one line: {added:?}"
            );
            let expected = [
                ("info", "boot sequence marker one"),
                ("warn", "boot sequence marker two"),
                ("error", "boot sequence marker three"),
            ];
            for (line, (want_level, want_msg)) in mine.iter().zip(expected) {
                let (level, msg) = split_line(line);
                assert_eq!(level, want_level, "level not carried through: {line:?}");
                assert_eq!(msg, want_msg, "message not written verbatim: {line:?}");
            }
        });
    }

    #[test]
    fn a_secret_shaped_message_lands_on_exactly_one_whole_line() {
        // The redaction filter can only drop a credential it can see WHOLE.
        // A JWT split across two lines is two innocuous lines that match no
        // keyword and no JWT rule, and it ships to the UI and the report.
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        with_global_sink(|path| {
            let before = read(path);
            log_info!("refreshing session {jwt}");
            let added = appended_since(path, &before);
            // Count the lines that CARRY the JWT. Split it in two and neither
            // half matches, so this fails exactly when the credential would
            // have reached the filter unrecognisable.
            let carriers: Vec<&str> = added.lines().filter(|l| l.contains(jwt)).collect();
            assert_eq!(
                carriers.len(),
                1,
                "the JWT must appear whole on exactly one line: {added:?}"
            );
            let (_, msg) = split_line(carriers[0]);
            assert_eq!(
                msg,
                format!("refreshing session {jwt}"),
                "the JWT was split or mangled, so `diagnostics` cannot redact it: {msg:?}"
            );
        });
    }

    // ----------------------------------------------------------------------
    // Line atomicity — the security-relevant one
    // ----------------------------------------------------------------------

    #[test]
    fn concurrent_writes_never_interleave_within_a_line() {
        with_global_sink(|path| {
            let before = read(path);
            std::thread::scope(|scope| {
                for t in 0..CONC_THREADS {
                    scope.spawn(move || {
                        // A distinct filler character AND a distinct writer id
                        // per thread, so any mixing of two writers inside one
                        // line is visible two ways.
                        let marker = char::from(b'A' + t as u8);
                        let payload =
                            format!("netpulse-conc-writer-{t} {}", marker.to_string().repeat(CONC_PAD));
                        for _ in 0..CONC_PER_THREAD {
                            log_info!("{payload}");
                        }
                    });
                }
            });
            let added = appended_since(path, &before);
            let mine: Vec<&str> = added
                .lines()
                .filter(|l| l.contains("netpulse-conc-writer-"))
                .collect();
            assert_eq!(
                mine.len(),
                CONC_THREADS * CONC_PER_THREAD,
                "lines were merged or dropped -- a write was not atomic"
            );
            for line in &mine {
                let (_, msg) = split_line(line);
                let (writer, body) = msg
                    .split_once(' ')
                    .unwrap_or_else(|| panic!("a write was cut short: {line:?}"));
                assert_eq!(
                    body.len(),
                    CONC_PAD,
                    "two writers shared one line: {line:?}"
                );
                let first = body.as_bytes()[0];
                assert!(
                    body.bytes().all(|b| b == first),
                    "two writers' payloads were mixed into one line: {line:?}"
                );
                // And the filler must be THIS writer's, not a neighbour's.
                let id: usize = writer
                    .rsplit('-')
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or_else(|| panic!("writer id was mangled: {line:?}"));
                assert_eq!(
                    first,
                    b'A' + id as u8,
                    "the payload belongs to a different writer than the header says: {line:?}"
                );
            }
        });
    }

    #[test]
    fn rapid_sequential_writes_do_not_share_a_line() {
        with_global_sink(|path| {
            let before = read(path);
            for i in 0..500 {
                log_info!("rapid write {i} with a little padding to widen the window");
            }
            let added = appended_since(path, &before);
            let mine: Vec<&str> = added
                .lines()
                .filter(|l| l.contains("rapid write "))
                .collect();
            assert_eq!(mine.len(), 500, "a rapid write was not atomic");
            for (i, line) in mine.iter().enumerate() {
                let (_, msg) = split_line(line);
                assert_eq!(msg, format!("rapid write {i} with a little padding to widen the window"));
            }
        });
    }

    // ----------------------------------------------------------------------
    // Append behaviour
    // ----------------------------------------------------------------------

    #[test]
    fn appending_creates_the_log_file_and_never_rewrites_what_is_there() {
        let dir = scratch("append");
        let path = dir.join("netpulse.log");
        append_line(&path, "1700000000 1 [info] first\n");
        assert_eq!(read(&path), "1700000000 1 [info] first\n");
        append_line(&path, "1700000001 2 [warn] second\n");
        assert_eq!(
            read(&path),
            "1700000000 1 [info] first\n1700000001 2 [warn] second\n",
            "append must never rewrite or truncate what is already there"
        );
    }

    #[test]
    fn writing_recreates_a_log_directory_that_disappeared_under_a_running_app() {
        // A release build is `windows_subsystem="windows"`: there is no
        // console, so a dropped line is a dropped line for good. `reset_app_state`
        // and anything else tidying the app dir can remove the directory while
        // the app runs, and the sink is never re-pointed.
        let dir = scratch("missing-dir");
        let path = dir.join("nested").join("logs").join("netpulse.log");
        assert!(!path.parent().expect("parent").exists(), "precondition");

        append_line(&path, "1700000000 1 [info] after the directory vanished\n");

        assert!(
            path.exists(),
            "a vanished log dir must not silently discard every later line"
        );
        assert_eq!(
            read(&path),
            "1700000000 1 [info] after the directory vanished\n"
        );
    }

    // ----------------------------------------------------------------------
    // Rotation
    // ----------------------------------------------------------------------

    #[test]
    fn rotation_moves_the_whole_file_so_no_line_is_ever_split() {
        // Deliberately ends WITHOUT a newline: a rotator that truncated at
        // the cap would leave exactly this half-line behind, and a half-line
        // can be half a credential.
        let dir = scratch("rotate-whole");
        let path = dir.join("netpulse.log");
        let mut body = String::new();
        for i in 0..200 {
            body.push_str(&format!("1700000000 {i} [info] a line with some content\n"));
        }
        body.push_str("1700000009 999 [info] TRAILING-PARTIAL-LINE-NO-NEWLINE");
        std::fs::write(&path, &body).expect("seed");
        let size = body.len() as u64;

        assert!(rotate_if_over_cap(&path, size - 1), "over the cap must rotate");
        assert_eq!(
            std::fs::read_to_string(dir.join("netpulse.log.1")).expect("archive"),
            body,
            "the archive must be byte-identical: rotation truncates nothing"
        );
        assert!(
            !path.exists(),
            "rotation moves the file; it must not leave a truncated one behind"
        );
    }

    #[test]
    fn the_first_write_after_a_rotation_starts_a_fresh_file() {
        let dir = scratch("rotate-then-write");
        let path = dir.join("netpulse.log");
        let old = "1700000000 1 [info] the previous session\n";
        std::fs::write(&path, old).expect("seed");

        assert!(rotate_if_over_cap(&path, old.len() as u64 - 1));
        append_line(&path, "1700000001 2 [info] the new session\n");

        assert_eq!(
            read(&path),
            "1700000001 2 [info] the new session\n",
            "the live log is the new session only"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("netpulse.log.1")).expect("archive"),
            old,
            "the previous session is kept intact alongside it"
        );
    }

    #[test]
    fn a_missing_log_file_is_not_a_rotation() {
        let dir = scratch("rotate-missing");
        let path = dir.join("netpulse.log");
        assert!(!rotate_if_over_cap(&path, 0), "nothing to rotate");
        assert!(
            !dir.join("netpulse.log.1").exists(),
            "no archive may appear out of nothing"
        );
    }

    #[test]
    fn a_file_exactly_at_the_cap_is_kept_and_one_byte_over_is_rotated() {
        // The real LOG_CAP_BYTES, at its exact boundary.
        let dir = scratch("cap-boundary");
        let path = dir.join("netpulse.log");
        let filler = "x".repeat(LOG_CAP_BYTES as usize);
        std::fs::write(&path, &filler).expect("seed");

        assert!(
            !rotate_if_over_cap(&path, LOG_CAP_BYTES),
            "a file exactly AT the cap is still within it"
        );
        assert!(path.exists(), "no rotation at exactly the cap");

        std::fs::write(&path, format!("{filler}y")).expect("seed over");
        assert_eq!(
            std::fs::metadata(&path).expect("size").len(),
            LOG_CAP_BYTES + 1
        );
        assert!(
            rotate_if_over_cap(&path, LOG_CAP_BYTES),
            "one byte over the cap must rotate"
        );
        assert!(!path.exists(), "rotated at cap + 1");
        assert_eq!(
            std::fs::metadata(dir.join("netpulse.log.1")).expect("archive").len(),
            LOG_CAP_BYTES + 1
        );
    }

    #[test]
    fn the_cap_boundary_is_exact_just_under_exactly_at_and_just_over() {
        for (size, expect_rotate) in [(99u64, false), (100, false), (101, true)] {
            let dir = scratch("cap-param");
            let path = dir.join("netpulse.log");
            std::fs::write(&path, "y".repeat(size as usize)).expect("seed");
            assert_eq!(
                rotate_if_over_cap(&path, 100),
                expect_rotate,
                "{size} bytes against a cap of 100"
            );
        }
    }

    // ----------------------------------------------------------------------
    // The panic hook
    // ----------------------------------------------------------------------

    #[test]
    fn install_panic_hook_routes_a_panic_into_the_same_log_file() {
        with_global_sink(|path| {
            let before = read(path);
            install_panic_hook();
            let caught = std::panic::catch_unwind(|| {
                panic!("netpulse-panic-canary");
            });
            assert!(caught.is_err(), "the canary must actually panic");

            let added = appended_since(path, &before);
            assert!(
                added.contains("PANIC"),
                "the panic hook did not reach the log writer: {added:?}"
            );
            assert!(
                added.contains("netpulse-panic-canary"),
                "the panic message was lost: {added:?}"
            );
            let line = added
                .lines()
                .find(|l| l.contains("PANIC"))
                .unwrap_or_else(|| panic!("the panic hook did not reach the log writer: {added:?}"));
            let (_, msg) = split_line(line);
            assert!(
                msg.starts_with("PANIC:") && msg.contains("netpulse-panic-canary"),
                "the panic must arrive as ONE whole line, not split across two: {msg:?}"
            );
        });
    }

    #[test]
    fn the_log_cap_is_the_size_the_system_health_page_advertises() {
        assert_eq!(LOG_CAP_BYTES, 512 * 1024);
    }
}
