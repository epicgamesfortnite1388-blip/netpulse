//! Sidecar supervision: spawn the bundled Node backend, keep it alive, and
//! tear it down deterministically.
//
//! Everything here is about a CHILD PROCESS — what to run, on which
//! loopback port, with which in-memory token, what to do when it dies, and
//! when a crash-loop must stop being retried. Concerns that merely looked
//! adjacent live elsewhere:
//!   - `logging`     — who writes the rotating log (this file only calls it)
//!   - `ports`       — the two pure OS questions about a loopback port
//!   - `webview_gc`  — reaping webview processes orphaned by a past crash
//!   - `tray`        — the tray icon and its quit path
//!
//! The watchdog decision itself (`watchdog_tick`) is a pure function on
//! purpose: the respawn budget, the cooldown and the re-arm rule are the
//! policy most likely to be wrong and the hardest to see failing live, so
//! they are tested without a Tauri app or a real child.

use crate::logging::{log_error, log_info, log_warn};
use crate::ports::{port_bindable, reserve_ephemeral_port};
use rand::RngCore;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

// spawn_sidecar sets CREATE_NO_WINDOW so no console window flashes
// beside the app; a release build has no console to inherit.
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;


/// ---------------------------------------------------------------------------
/// Sidecar supervisor
///
/// Runs the packaged Node backend as a supervised child process bound to
/// 127.0.0.1:<ephemeral-port>, authenticated by an ephemeral daemon token
/// generated here and held only in memory.
///
/// The token is:
///   - generated with the OS CSPRNG (32 bytes)
///   - passed to the sidecar via stdin (not argv, so it never shows in
///     process listings)
///   - handed to the webview only via the typed `bootstrap` IPC command
///   - never written to disk
///
/// If the sidecar exits unexpectedly it is restarted with bounded backoff
/// (max 5 attempts) unless shutdown is in progress.
/// ---------------------------------------------------------------------------
pub struct SidecarState {
    pub inner: Mutex<SidecarInner>,
}

pub struct SidecarInner {
    pub child: Option<Child>,
    pub port: u16,
    pub token: String,
    pub restarts: u32,
    /// When the current child was spawned; used to reset the restart counter
    /// after a stable period so a crash-loop cap never becomes permanent.
    pub spawned_at: Option<std::time::Instant>,
    /// Startup buffer: the last stderr lines of the CURRENT spawn (bounded).
    /// Flushed to the log with the exit status when the child dies, so even a
    /// silent early death is fully diagnosable from the log file.
    pub startup_buf: Arc<Mutex<VecDeque<String>>>,
    /// Most recent sidecar death, surfaced on the System Health page so the
    /// user can see WHY the backend last restarted without opening the log.
    pub last_restart_reason: Option<String>,
    /// Unix seconds of the most recent sidecar death (None = never died).
    pub last_restart_at_unix: Option<u64>,
    shutting_down: bool,
}

impl SidecarState {
    pub fn new() -> Self {
        // The local update feed bakes `http://127.0.0.1:<port>/...` into the
        // binary (the updater plugin has no runtime endpoint override), so the
        // sidecar must LISTEN on the port the endpoint names. Try the fixed
        // feed port first — the previous instance released it seconds ago, so
        // the OS normally offers it right back — and fall back to an ephemeral
        // port only if something else took it (the feed then 404s honestly:
        // the updater reports its real connection error instead of a fake).
        let port = [LOCAL_FEED_PORT, 0]
            .iter()
            .find(|p| port_bindable(**p))
            .copied()
            .unwrap_or_else(reserve_ephemeral_port);
        Self {
            inner: Mutex::new(SidecarInner {
                child: None,
                port,
                token: generate_token(),
                restarts: 0,
                spawned_at: None,
                startup_buf: Arc::new(Mutex::new(VecDeque::new())),
                last_restart_reason: None,
                last_restart_at_unix: None,
                shutting_down: false,
            }),
        }
    }
}

/// The loopback port the built-in updater endpoint names
/// (`http://127.0.0.1:47615/api/v1/update-feed/latest.json`). Must match
/// LOCAL_FEED_PORT in scripts/lib/updateFeed.mjs — test:feed pins the pair.
#[cfg(target_os = "windows")]
const LOCAL_FEED_PORT: u16 = 47_615;
#[cfg(not(target_os = "windows"))]
const LOCAL_FEED_PORT: u16 = 0; // non-Windows dev builds: ephemeral, feed unused

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

/// Current Unix time in seconds (for last-restart timestamps).
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// How long `bootstrap` waits for the sidecar to answer before handing the
/// webview a port/token anyway (the UI then shows its honest offline state).
/// Generous on purpose: a first launch on a large database runs migrations and
/// integrity checks, and waiting is strictly better than telling the user the
/// backend is unreachable while it is still starting.
pub const BOOTSTRAP_READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Poll the sidecar's loopback port until it accepts a connection or `timeout`
/// elapses. A listening socket IS the readiness signal: `desktop-index.ts` only
/// binds after the whole app (config, database, auth, routes) is constructed,
/// so a successful connect means the first authenticated request will be
/// answered instead of racing start-up the way a fixed delay would.
///
/// Returns `true` as soon as the port answers. A connect that is refused (or
/// times out) simply means "not yet" — never an error.
pub fn wait_for_sidecar_ready(port: u16, timeout: Duration) -> bool {
    if port == 0 {
        return false;
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(75));
    }
}

/// Locate the packaged backend binary next to the current executable.
/// Falls back to `node` + script for `tauri dev` runs.
fn resolve_backend(_app: &AppHandle) -> (Command, String) {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    // Production resolution order:
    //   1. bundled portable Node runtime + backend script (no user Node needed)
    //   2. system node + backend script (dev)
    if let Some(dir) = &exe_dir {
        let portable_node = if cfg!(target_os = "windows") {
            dir.join("backend").join("node.exe")
        } else {
            dir.join("backend").join("bin").join("node")
        };
        let script = dir.join("backend").join("netpulse-backend.js");
        if portable_node.exists() && script.exists() {
            let mut cmd = Command::new(&portable_node);
            cmd.arg(&script);
            return (cmd, format!("portable:{}", portable_node.display()));
        }
    }

    // Dev fallback: system node + the staged CJS backend.
    let mut cmd = Command::new("node");
    let mut script = std::path::PathBuf::from("backend/netpulse-backend.js");
    if let Ok(cwd) = std::env::current_dir() {
        for candidate in [
            cwd.join("backend/netpulse-backend.js"),
            cwd.join("src-tauri/backend/netpulse-backend.js"),
        ] {
            if candidate.exists() {
                script = candidate;
                break;
            }
        }
    }
    cmd.arg(script);
    (cmd, "dev:node".to_string())
}

/// Spawn the sidecar. Token is delivered via stdin; port via env.
/// Never panics; all failures are logged and reported to the caller.
pub fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut inner = state.inner.lock().map_err(|_| "sidecar state poisoned")?;

    if inner.shutting_down {
        return Ok(());
    }

    // Replace any existing child deterministically: dropping a Child handle
    // does NOT kill the process on Windows, so an explicit kill prevents
    // orphan duplicates when respawn runs while one is still alive.
    if let Some(old) = inner.child.as_mut() {
        let _ = old.kill();
        let _ = old.wait();
    }
    inner.child = None;

    // The reserved port can be stolen between reservation and bind (bind-and-
    // release is inherently racy). A stolen port makes the sidecar die with
    // EADDRINUSE before it can print anything useful, so re-reserve when our
    // own test bind no longer succeeds.
    if !port_bindable(inner.port) {
        let fresh = reserve_ephemeral_port();
        log_warn!(
            "reserved sidecar port {} is occupied; re-reserved {}",
            inner.port,
            fresh
        );
        inner.port = fresh;
    }

    let (mut cmd, source) = resolve_backend(app);
    // NETPULSE_DATA_DIR is set in main.rs setup and inherited by the child, but
    // set it explicitly here too so the sidecar always has it even if the env
    // inheritance is disrupted (e.g. by a sandbox or AV hook).
    let data_dir = app.path().app_data_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "".to_string());
    cmd.env("NETPULSE_PORT", inner.port.to_string())
        .env("NETPULSE_DESKTOP", "1")
        .env("NODE_ENV", "production")
        .env("NETPULSE_DATA_DIR", data_dir.clone())
        // Local update feed: the sidecar serves latest.json + the signed
        // artifact from this dir under the app data dir; the updater endpoint
        // baked into the binary points the updater at the sidecar itself.
        .env("NETPULSE_RELEASE_DIR", format!("{}\\releases", data_dir));

    // Absolute node_modules dir for the bundle's fallback module resolver;
    // migrations folder travels with the bundled backend resources.
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let mods = exe_dir.join("backend").join("node_modules");
        if mods.exists() {
            cmd.env("NETPULSE_MODULES_DIR", mods);
        }
        let mig = exe_dir.join("backend").join("drizzle");
        if mig.exists() {
            cmd.env("NETPULSE_MIGRATIONS_DIR", mig);
        }
    }

    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    // Windows: no console window flashes for managed children
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("sidecar spawn failed: {e}");
            log_error!("{msg}");
            return Err(msg);
        }
    };

    // Feed the ephemeral token through stdin. stdin is deliberately kept OPEN
    // for the sidecar's lifetime: it is the lifecycle channel — when the
    // supervisor exits or is killed, the OS closes the pipe, the backend sees
    // EOF and shuts down (orphan protection even if the watchdog dies).
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        let _ = stdin.write_all(inner.token.as_bytes());
        let _ = stdin.flush();
    }

    // Fresh startup buffer for THIS spawn: the last STARTUP_BUF_LINES stderr
    // lines are kept here in addition to being logged live, so a death can be
    // reported with the exact output that preceded it.
    let buf: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(STARTUP_BUF_LINES)));
    inner.startup_buf = buf.clone();

    // Pipe stderr to the log file + startup buffer (+ webview event channel).
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log_info!("sidecar: {line}");
                if let Ok(mut b) = buf.lock() {
                    if b.len() >= STARTUP_BUF_LINES {
                        b.pop_front();
                    }
                    b.push_back(line);
                }
            }
        });
    }

    log_info!("sidecar started ({source}) on port {} (startup buffer armed, {STARTUP_BUF_LINES} lines)", inner.port);
    // NOTE: the restart counter is intentionally NOT reset here — it is owned
    // by the watchdog state machine (`watchdog_tick`), which re-arms it after
    // a stable period. Resetting on spawn made the crash-loop cap dead code.
    inner.spawned_at = Some(std::time::Instant::now());
    inner.child = Some(child);

    // Tell the webview: its transport memoizes the bootstrap (port/token), so
    // a respawn — especially on a re-reserved port — MUST invalidate it or the
    // UI polls a dead endpoint forever while this sidecar is healthy.
    let _ = app.emit("sidecar-restarted", inner.port);
    Ok(())
}

/// Decode exit codes that carry a well-known meaning for this sidecar.
/// Returns an empty string for codes with nothing useful to add.
fn decode_exit_code(code: i32) -> &'static str {
    match code as u32 {
        0xC000_0135 => "STATUS_DLL_NOT_FOUND — a required DLL is missing next to the process",
        0xC000_0142 => "STATUS_DLL_INIT_FAILED — a DLL failed to initialize",
        0xC000_0005 => "STATUS_ACCESS_VIOLATION — native crash",
        0xC000_0409 => "STATUS_STACK_BUFFER_OVERRUN — fail-fast abort",
        0x8000_0003 => "STATUS_BREAKPOINT — aborted at a breakpoint",
        78 => "EX_CONFIG — supervisor handshake failed (daemon token not received on stdin)",
        _ => "",
    }
}

/// Human-readable diagnosis for a dead sidecar: OS exit status (with common
/// loader/handshake codes decoded) plus the captured startup buffer. An empty
/// buffer is called out explicitly — it means the backend never even started,
/// which points at loader-level causes (AV, missing dependency, external kill)
/// rather than backend code.
fn describe_death(code: Option<i32>, stderr_tail: &[String]) -> String {
    let status_str = match code {
        Some(c) => {
            let note = decode_exit_code(c);
            if note.is_empty() {
                format!("exit code {c} (0x{:08X})", c as u32)
            } else {
                format!("exit code {c} (0x{:08X}, {note})", c as u32)
            }
        }
        None => "unknown status".to_string(),
    };
    if code == Some(-1) {
        // Exit code -1 (0xFFFFFFFF) on Windows means the process was terminated
        // by an external force: typically AV/Defender killing a suspicious process,
        // or the parent/OS terminating it. This is NOT a normal exit or a crash.
        if stderr_tail.is_empty() {
            return String::from("sidecar was KILLED by an external process (exit code -1 / 0xFFFFFFFF) before it could produce any output. \
                 The bundled node.exe likely triggered antivirus or Windows Defender heuristic detection. \
                 Try: running the app as administrator once to add an exclusion, checking Windows Defender logs \
                 (Microsoft-Windows-Windows Defender/Operational event log), or reporting this as a false positive to your AV vendor.");
        }
        return format!(
            "sidecar was KILLED by an external process (exit code -1 / 0xFFFFFFFF) after producing some output. \
             The backend started but was terminated by something outside the app — most commonly antivirus/Defender. \
             Last stderr lines: {stderr_tail:?}"
        );
    }
    if stderr_tail.is_empty() {
        format!(
            "sidecar died with {status_str} and produced NO stderr output — the backend never started; \
             likely causes: antivirus blocking the bundled node.exe, a missing runtime dependency, or an external kill"
        )
    } else {
        let start = stderr_tail.len().saturating_sub(10);
        let shown = &stderr_tail[start..];
        format!(
            "sidecar died with {status_str}; last {} stderr line(s) before death:\n  {}",
            shown.len(),
            shown.join("\n  ")
        )
    }
}
/// Rapid-respawn budget before the watchdog enters a cooldown.
pub const MAX_RAPID_RESTARTS: u32 = 5;
/// Uptime after which the restart budget re-arms (failure was transient).
pub const STABLE_REARM: Duration = Duration::from_secs(60);
/// Crash-loop cooldown before re-arming with a fresh budget.
pub const COOLDOWN: Duration = Duration::from_secs(60);
/// Stderr lines retained per spawn for death diagnostics.
pub const STARTUP_BUF_LINES: usize = 64;

/// What the watchdog should do on this tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchdogAction {
    /// Child is alive; keep polling.
    Continue,
    /// Child is dead (or was never spawned); spawn a replacement now.
    Respawn,
    /// Rapid crash-loop: stop respawning for the given duration, then re-arm.
    Cooldown(Duration),
}

/// Pure watchdog state machine — the decision core of `start_watchdog`,
/// separated so the respawn/crash-loop/re-arm behavior is unit-testable
/// without a Tauri app or real child processes.
///
/// * `restarts`   — rapid-restart counter currently in effect
/// * `has_child`  — a child handle exists
/// * `alive`      — that child is still running (false on wait error)
/// * `stable_for` — how long the current child has been up (None = no child)
///
/// Returns the action to take and the updated restart counter.
pub fn watchdog_tick(
    restarts: u32,
    has_child: bool,
    alive: bool,
    stable_for: Option<Duration>,
) -> (WatchdogAction, u32) {
    // A child that stayed up for STABLE_REARM proves the failure was
    // transient: re-arm the full crash-loop budget.
    let rearm = restarts > 0 && stable_for.map(|t| t >= STABLE_REARM).unwrap_or(false);
    let restarts = if rearm { 0 } else { restarts };
    if has_child && alive {
        return (WatchdogAction::Continue, restarts);
    }
    if restarts >= MAX_RAPID_RESTARTS {
        return (WatchdogAction::Cooldown(COOLDOWN), 0);
    }
    (WatchdogAction::Respawn, restarts + 1)
}

/// Watchdog: restart the sidecar if it dies. Runs for the whole app lifetime:
/// rapid crash-loops are capped, but the cap never becomes permanent — after a
/// cooldown the counter resets so a later transient failure still recovers.
pub fn start_watchdog(app: &AppHandle) {
    let app: &'static AppHandle = Box::leak(Box::new(app.clone()));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let state = app.state::<SidecarState>();
        // A poisoned mutex (a panic while holding the lock in spawn/stop) must
        // NOT end supervision: the data behind the lock is still valid enough
        // to restart from, and giving up here is exactly the "backend
        // unreachable forever, watchdog never respawns" failure mode. Recover
        // the inner state and keep the loop alive.
        let mut inner = match state.inner.lock() {
            Ok(i) => i,
            Err(p) => p.into_inner(),
        };
        if inner.shutting_down {
            // Intentional stop (app quit or a repair flow mid-reset): keep the
            // thread alive so it can resume supervising after `allow_respawn`.
            continue;
        }
        let stable_for = inner.spawned_at.map(|t| t.elapsed());
        let alive = inner
            .child
            .as_mut()
            .map(|c| c.try_wait().map(|s| s.is_none()).unwrap_or(false))
            .unwrap_or(false);
        let (action, restarts) =
            watchdog_tick(inner.restarts, inner.child.is_some(), alive, stable_for);
        inner.restarts = restarts;
        match action {
            WatchdogAction::Continue => {}
            WatchdogAction::Cooldown(d) => {
                // Death record: exit status + captured startup buffer.
                let status = inner.child.as_mut().and_then(|c| c.try_wait().ok().flatten());
                let tail: Vec<String> = inner
                    .startup_buf
                    .lock()
                    .map(|b| b.iter().cloned().collect())
                    .unwrap_or_default();
                let reason = describe_death(status.and_then(|s| s.code()), &tail);
                inner.last_restart_reason = Some(reason.clone());
                inner.last_restart_at_unix = Some(unix_now());
                log_error!("{reason}");
                log_error!(
                    "sidecar exited repeatedly; cooling down {}s before re-arming (GUI stays usable, backend offline)",
                    d.as_secs()
                );
                drop(inner);
                std::thread::sleep(d);
            }
            WatchdogAction::Respawn => {
                // Death record: exit status + captured startup buffer. This is
                // what makes a silent early death diagnosable from the log
                // alone — even when the child produced no output at all, the
                // record says so explicitly alongside the decoded exit code.
                let status = inner.child.as_mut().and_then(|c| c.try_wait().ok().flatten());
                let tail: Vec<String> = inner
                    .startup_buf
                    .lock()
                    .map(|b| b.iter().cloned().collect())
                    .unwrap_or_default();
                let reason = describe_death(status.and_then(|s| s.code()), &tail);
                inner.last_restart_reason = Some(reason.clone());
                inner.last_restart_at_unix = Some(unix_now());
                log_error!("{reason}");
                log_warn!(
                    "sidecar not alive; respawn attempt {}/{}",
                    inner.restarts,
                    MAX_RAPID_RESTARTS
                );
                drop(inner);
                let _ = spawn_sidecar(app);
            }
        }
    });
}

/// Graceful shutdown of the sidecar.
/// Invoked from the Tauri `RunEvent::Exit` hook in main.rs so tray Quit and
/// every other exit path tears the sidecar down deterministically.
pub fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mut inner = match state.inner.lock() {
        Ok(i) => i,
        Err(_) => return,
    };
    inner.shutting_down = true;
    if let Some(child) = inner.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    inner.child = None;
    log_info!("sidecar stopped");
}

/// Re-enable sidecar spawning after an intentional `stop_sidecar`. Repair
/// flows (Reset App State, Restart Backend) must call this before
/// `spawn_sidecar` — the app-quit path never does, so quitting still
/// suppresses respawns.
pub fn allow_respawn(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let lock = state.inner.lock();
    if let Ok(mut inner) = lock {
        inner.shutting_down = false;
        inner.spawned_at = None;
    }
}

/// ---------------------------------------------------------------------------
/// Tests — watchdog respawn loop, crash-loop cooldown, re-arm, port helpers.
/// Pure-function coverage for the state machine in `watchdog_tick` plus the
/// port reservation helpers; the real sidecar boot is covered live by the
/// desktop pipeline smoke test and the installed-build verification.
/// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    // ---------------- watchdog_tick: happy path ----------------

    #[test]
    fn alive_child_continues_without_touching_counter() {
        let (action, restarts) = watchdog_tick(0, true, true, Some(Duration::from_secs(5)));
        assert_eq!(action, WatchdogAction::Continue);
        assert_eq!(restarts, 0);
    }

    #[test]
    fn alive_child_with_prior_restarts_keeps_counter_until_stable() {
        // 2 rapid deaths, current child up 10s: no re-arm yet, no action.
        let (action, restarts) = watchdog_tick(2, true, true, Some(Duration::from_secs(10)));
        assert_eq!(action, WatchdogAction::Continue);
        assert_eq!(restarts, 2);
    }

    // ---------------- watchdog_tick: respawn path ----------------

    #[test]
    fn dead_child_respawns_and_increments_counter() {
        let (action, restarts) = watchdog_tick(0, true, false, Some(Duration::from_secs(1)));
        assert_eq!(action, WatchdogAction::Respawn);
        assert_eq!(restarts, 1);
    }

    #[test]
    fn missing_child_respawns_too() {
        // spawn never succeeded (child = None): same respawn semantics.
        let (action, restarts) = watchdog_tick(2, false, false, None);
        assert_eq!(action, WatchdogAction::Respawn);
        assert_eq!(restarts, 3);
    }

    #[test]
    fn counter_accumulates_across_rapid_deaths() {
        // Regression guard: the old code reset the counter on every spawn,
        // which made the crash-loop cap unreachable. Five rapid deaths get
        // five respawn attempts; the sixth dead tick enters the cooldown.
        let mut restarts = 0;
        for expected in 1..=MAX_RAPID_RESTARTS {
            let (action, r) = watchdog_tick(restarts, true, false, Some(Duration::from_secs(2)));
            assert_eq!(action, WatchdogAction::Respawn);
            assert_eq!(r, expected);
            restarts = r;
        }
        // Budget exhausted.
        let (action, r) = watchdog_tick(restarts, true, false, Some(Duration::from_secs(2)));
        assert_eq!(action, WatchdogAction::Cooldown(COOLDOWN));
        assert_eq!(r, 0);
    }

    // ---------------- watchdog_tick: crash-loop cooldown ----------------

    #[test]
    fn budget_exhaustion_cooldowns_and_rearms() {
        let (action, restarts) = watchdog_tick(MAX_RAPID_RESTARTS, true, false, Some(Duration::from_secs(2)));
        assert_eq!(action, WatchdogAction::Cooldown(Duration::from_secs(60)));
        assert_eq!(restarts, 0); // fresh budget after the cooldown
    }

    #[test]
    fn cooldown_leads_to_a_fresh_respawn() {
        // After the cooldown the counter is 0, so the next dead tick respawns
        // with a full budget again (never gives up permanently).
        let (_, after_cooldown) = watchdog_tick(5, true, false, Some(Duration::from_secs(2)));
        assert_eq!(after_cooldown, 0);
        let (action, restarts) = watchdog_tick(after_cooldown, false, false, None);
        assert_eq!(action, WatchdogAction::Respawn);
        assert_eq!(restarts, 1);
    }

    // ---------------- watchdog_tick: stable-period re-arm ----------------

    #[test]
    fn stable_period_rearms_after_deaths() {
        // 3 rapid deaths, then the child stayed up 61s and died again:
        // counter resets first, so this is a fresh Respawn (budget re-armed).
        let (action, restarts) = watchdog_tick(3, true, false, Some(Duration::from_secs(61)));
        assert_eq!(action, WatchdogAction::Respawn);
        assert_eq!(restarts, 1);
    }

    #[test]
    fn stable_period_rearms_even_while_alive() {
        // 2 deaths, child now up 90s: counter clears on a normal tick.
        let (action, restarts) = watchdog_tick(2, true, true, Some(Duration::from_secs(90)));
        assert_eq!(action, WatchdogAction::Continue);
        assert_eq!(restarts, 0);
    }

    #[test]
    fn no_rearm_below_stable_threshold() {
        // 4 rapid deaths, child only survived 59s: no re-arm, 5th death
        // exhausts the budget.
        let (action, restarts) = watchdog_tick(4, true, false, Some(Duration::from_secs(59)));
        assert_eq!(action, WatchdogAction::Respawn);
        assert_eq!(restarts, 5);
    }

    #[test]
    fn rearm_threshold_is_inclusive() {
        // Exactly STABLE_REARM uptime counts as stable.
        let (action, restarts) = watchdog_tick(3, true, false, Some(STABLE_REARM));
        assert_eq!(action, WatchdogAction::Respawn);
        assert_eq!(restarts, 1);
    }

    // ---------------- port helpers ----------------

    #[test]
    fn reserved_port_is_bindable_and_nonzero() {
        let port = reserve_ephemeral_port();
        assert_ne!(port, 0, "ephemeral reservation must yield a real port");
        assert!(port_bindable(port), "freshly reserved port must be free");
    }

    #[test]
    fn occupied_port_is_not_bindable() {
        let port = reserve_ephemeral_port();
        let guard = TcpListener::bind(("127.0.0.1", port)).expect("test listener binds");
        assert!(
            !port_bindable(port),
            "a held port must be reported as not bindable"
        );
        drop(guard);
    }

    #[test]
    fn port_re_reserve_picks_a_free_port_when_occupied() {
        // Mirrors the spawn-side guard: occupied reserved port -> fresh port.
        let stolen = reserve_ephemeral_port();
        let _guard = TcpListener::bind(("127.0.0.1", stolen)).unwrap();
        let fresh = if port_bindable(stolen) { stolen } else { reserve_ephemeral_port() };
        assert_ne!(fresh, stolen);
        assert!(port_bindable(fresh));
    }

    // ---------------- token hygiene ----------------

    #[test]
    fn token_is_64_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn tokens_are_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
    }

    // ---------------- constants sanity ----------------

    // ---------------- death diagnostics ----------------

    #[test]
    fn decodes_windows_loader_failures() {
        // 0xC0000135 as i32 is negative (bit pattern preserved through `as`).
        assert!(decode_exit_code(0xC000_0135u32 as i32).contains("STATUS_DLL_NOT_FOUND"));
        assert!(decode_exit_code(0xC000_0142u32 as i32).contains("STATUS_DLL_INIT_FAILED"));
        assert!(decode_exit_code(0xC000_0005u32 as i32).contains("STATUS_ACCESS_VIOLATION"));
        assert!(decode_exit_code(0xC000_0409u32 as i32).contains("STATUS_STACK_BUFFER_OVERRUN"));
    }

    #[test]
    fn decodes_handshake_and_clean_exit() {
        assert!(decode_exit_code(78).contains("EX_CONFIG"));
        assert!(!decode_exit_code(0).contains("handshake"));
        assert_eq!(decode_exit_code(0), "");
        assert_eq!(decode_exit_code(1), "");
    }

    #[test]
    fn empty_death_record_reports_silent_death() {
        let msg = describe_death(Some(0xC000_0135u32 as i32), &[]);
        assert!(msg.contains("NO stderr output"), "msg: {msg}");
        assert!(msg.contains("STATUS_DLL_NOT_FOUND"), "msg: {msg}");
        assert!(msg.contains("antivirus"), "msg: {msg}");
    }

    #[test]
    fn death_record_includes_stderr_tail() {
        let lines: Vec<String> = (1..=12).map(|i| format!("boot stage={i}")).collect();
        let msg = describe_death(Some(1), &lines);
        assert!(msg.contains("exit code 1 (0x00000001)"), "msg: {msg}");
        assert!(msg.contains("last 10 stderr line(s)"), "msg: {msg}");
        // Only the last 10 lines are shown.
        assert!(msg.contains("boot stage=12"), "msg: {msg}");
        assert!(!msg.contains("boot stage=1
"), "msg: {msg}");
    }

    #[test]
    fn death_record_handles_unknown_status() {
        let msg = describe_death(None, &[]);
        assert!(msg.contains("unknown status"), "msg: {msg}");
        assert!(msg.contains("NO stderr output"), "msg: {msg}");
    }

    #[test]
    fn constants_are_sane() {
        assert_eq!(MAX_RAPID_RESTARTS, 5);
        assert_eq!(STABLE_REARM, Duration::from_secs(60));
        assert_eq!(COOLDOWN, Duration::from_secs(60));
        // The bootstrap wait must outlast a cold first launch (migrations +
        // integrity check) — that is the state it exists to cover.
        assert!(BOOTSTRAP_READY_TIMEOUT >= Duration::from_secs(15));
    }

    #[test]
    fn ready_wait_returns_true_once_the_port_answers() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().expect("addr").port();
        // Accept in the background so the connect completes.
        let acceptor = std::thread::spawn(move || {
            let _ = listener.accept();
        });
        let started = std::time::Instant::now();
        assert!(wait_for_sidecar_ready(port, Duration::from_secs(5)));
        // Answered on the first probe, before any sleep cycle.
        assert!(started.elapsed() < Duration::from_secs(1));
        let _ = acceptor.join();
    }

    #[test]
    fn ready_wait_times_out_on_a_closed_port_instead_of_hanging() {
        // A reserved-then-released port: nothing is listening on it.
        let port = reserve_ephemeral_port();
        assert!(port != 0, "an ephemeral port must be reservable for this test");
        let started = std::time::Instant::now();
        assert!(!wait_for_sidecar_ready(port, Duration::from_millis(400)));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(400), "waited: {waited:?}");
        assert!(waited < Duration::from_secs(3), "waited: {waited:?}");
    }

    #[test]
    fn ready_wait_does_not_probe_port_zero() {
        assert!(!wait_for_sidecar_ready(0, Duration::from_millis(50)));
    }
}
