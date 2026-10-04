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

use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Logging facade — eprintln in dev, always mirrored to a rotating log file in
// the app data dir once logging is initialized. Startup failures MUST be
// visible somewhere the user can find them (a console window does not exist in
// a windows_subsystem="windows" release build).
// ---------------------------------------------------------------------------

static LOG_FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn init_logging(data_dir: &str) {
    // The same resolver every reader uses, so the directory we CREATE is by
    // construction the directory `paths::log_dir` reports.
    let dir = crate::paths::log_dir_in(std::path::Path::new(data_dir));
    let _ = std::fs::create_dir_all(&dir);
    // Rotate: keep the previous file as .log.1, cap size at ~1 MB.
    let path = dir.join("netpulse.log");
    if path.exists() {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > LOG_CAP_BYTES {
            let _ = std::fs::rename(&path, dir.join("netpulse.log.1"));
        }
    }
    LOG_FILE.set(Some(path)).ok();
    log_info!("logging initialized (data dir: {data_dir})");
}

pub fn write_log(level: &str, msg: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
    eprintln!("[netpulse:{level}] {msg}");
    if let Some(Some(path)) = LOG_FILE.get() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{ts} {seq} [{level}] {msg}");
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
        log_error!("PANIC: {info}");
        default(info);
    }));
}

/// Hard cap for the rotating startup log (~512 KB, two files total). Public so
/// runtime_status can surface the limit on the System Health page.
pub const LOG_CAP_BYTES: u64 = 512 * 1024;
