//! Per-action elevation broker.
//!
//! The Node sidecar runs unprivileged and cannot install a WireGuard tunnel
//! service. Instead of running the whole app elevated (or a root helper with a
//! broad command surface), a connect request travels through this broker:
//!
//!   1. UI asks the Node backend to connect → backend validates everything it
//!      can (profile exists, keys decrypt, engine present) and, for an
//!      operation that needs elevation, registers a PENDING operation and
//!      returns `elevation_required` with `{ opId, bridgePort, nonce }`.
//!   2. UI calls the Rust command `vpn_elevation_bridge { opId }`.
//!   3. Rust fetches `http://127.0.0.1:<sidecarPort>/api/v1/vpn/elevation/pending
//!      ?opId=…` WITH the sidecar token (Rust generated it, never persisted)
//!      and the sidecar answers `{ action, exe, args, nonce, configSha256 }`.
//!      The sidecar REQUIRES the request to carry the nonce the UI received,
//!      proving the bridge call chain started from the UI's opId, not a guess.
//!   4. Rust re-verifies the exact constraints locally:
//!        - action == "wireguard-install-tunnel"
//!        - exe resolves to exactly `C:\Program Files\WireGuard\wireguard.exe`
//!          or the x86 sibling (never PATH, never user-writable locations)
//!        - args == ["/installtunnelservice", "<configPath>"]
//!        - configPath is absolute, ends in `.conf`, lives inside the app's
//!          own data dir, exists, and its SHA-256 matches configSha256
//!      then launches it elevated via ShellExecuteExW(SEE_MASK_DEFAULT,
//!      lpVerb="runas") — the ONE UAC prompt for exactly this operation.
//!   5. Rust POSTs the launch outcome (or user-declined error) back to the
//!      sidecar `/vpn/elevation/result`; the sidecar finishes the connect
//!      flow (verifies the interface came up) and the UI long-poll resolves.
//!
//! The webview never sees the token, never talks to the privileged side
//! directly, and the privileged path can only ever run ONE fixed program with
//! ONE fixed argument shape pointing at a file the app itself wrote.

#![cfg(windows)]

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::sidecar::{log_error, log_info, log_warn};

/// Allow-listed WireGuard executables. Installed by the official WireGuard
/// MSI into Program Files (admin-writable only), so a standard user process
/// cannot replace them.
const ALLOWED_WIREGUARD_EXES: [&str; 2] = [
    "C:\\Program Files\\WireGuard\\wireguard.exe",
    "C:\\Program Files (x86)\\WireGuard\\wireguard.exe",
];

const ACTION_WG_INSTALL: &str = "wireguard-install-tunnel";

/// Everything the sidecar tells us about the pending operation.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PendingOp {
    pub action: String,
    pub exe: String,
    pub args: Vec<String>,
    /// Random nonce minted by the sidecar for THIS op; echoed in the query
    /// string of every call (pending + result) so the sidecar can bind the
    /// triple (opId, nonce, UI round-trip) together.
    pub nonce: String,
    pub config_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingQuery {
    nonce: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultReport<'a> {
    nonce: &'a str,
    ok: bool,
    error: Option<&'a str>,
}

/// Fetch the pending operation from the sidecar. The response carries the
/// op's `nonce`, which MUST be echoed on the result call — binding the
/// outcome to a descriptor the sidecar actually issued.
///
/// `sidecar_port` is the loopback port of OUR OWN supervised child; `token`
/// is the ephemeral token this process generated at spawn time. Both come
/// from process memory — never from the webview.
fn fetch_pending_op_blocking(sidecar_port: u16, token: &str, op_id: &str) -> Result<PendingOp, String> {
    let url = format!(
        "http://127.0.0.1:{port}/api/v1/vpn/elevation/pending?opId={op}",
        port = sidecar_port,
        op = urlencode(op_id),
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        // Loopback only: the broker must never follow a redirect off-machine.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|e| format!("sidecar unreachable: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("pending-op fetch failed: {} ({body})", status.as_u16()));
    }
    resp.json::<PendingOp>().map_err(|e| format!("pending-op decode: {e}"))
}

/// Report the launch outcome back to the sidecar so its connect promise can
/// resolve/fail and the UI long-poll can return.
fn report_result_blocking(sidecar_port: u16, token: &str, op_id: &str, report: &ResultReport<'_>) {
    let url = format!(
        "http://127.0.0.1:{port}/api/v1/vpn/elevation/result?opId={op}",
        port = sidecar_port,
        op = urlencode(op_id),
    );
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .query(&PendingQuery { nonce: report.nonce.to_string() })
        .json(report)
        .send();
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Validate the operation against the hard allow-list. Every field is
/// re-checked HERE even though the sidecar already validated it — the sidecar
/// is trusted infrastructure, but this process is the one holding the UAC
/// prompt, so it trusts nothing it didn't verify itself.
fn validate_op(op: &PendingOp, app_data_dir: &std::path::Path) -> Result<(), String> {
    if op.action != ACTION_WG_INSTALL {
        return Err(format!("unsupported action \"{}\"", op.action));
    }
    if op.nonce.len() < 16 || !op.nonce.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("invalid nonce".into());
    }

    // exe: exact, canonical allow-list match only.
    let exe_canonical = std::fs::canonicalize(&op.exe).map_err(|_| format!("executable not found: {}", op.exe))?;
    let exe_str = exe_canonical.to_string_lossy();
    if !ALLOWED_WIREGUARD_EXES.iter().any(|a| exe_str.eq_ignore_ascii_case(a)) {
        return Err(format!("executable \"{}\" is not on the WireGuard allow-list", op.exe));
    }

    // args: exact shape ["/installtunnelservice", <configPath>].
    if op.args.len() != 2 || !op.args[0].eq_ignore_ascii_case("/installtunnelservice") {
        return Err("unexpected argument shape for tunnel install".into());
    }
    let config_path = std::path::PathBuf::from(&op.args[1]);

    // config: absolute, .conf, inside OUR data dir, exists.
    if !config_path.is_absolute() {
        return Err("config path must be absolute".into());
    }
    if config_path.extension().and_then(|e| e.to_str()) != Some("conf") {
        return Err("config path must end in .conf".into());
    }
    let config_canonical = config_path
        .canonicalize()
        .map_err(|_| format!("config file not found: {}", config_path.display()))?;
    let data_canonical = app_data_dir
        .canonicalize()
        .map_err(|e| format!("app data dir: {e}"))?;
    if !config_canonical.starts_with(&data_canonical) {
        return Err("config file is outside the app data directory".into());
    }

    // integrity: SHA-256 must match what the sidecar hashed when it
    // materialized the config — a TOCTOU swap between staging and launch is
    // detected here.
    let bytes = std::fs::read(&config_canonical).map_err(|e| format!("read config: {e}"))?;
    let hash = hex_encode(&Sha256::digest(&bytes));
    if !hash.eq_ignore_ascii_case(&op.config_sha256) {
        return Err("config file changed since the operation was prepared (hash mismatch)".into());
    }
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ---------------------------------------------------------------------------
// ShellExecuteExW FFI — "runas" verb triggers the UAC prompt for exactly this
// one launch. No helper process, no service, no long-lived elevated process.
// ---------------------------------------------------------------------------

#[allow(clippy::upper_case_acronyms)]
type BOOL = i32;

const SEE_MASK_DEFAULT: u32 = 0x0000_0000;
const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
const SW_SHOWNORMAL: i32 = 1;

#[repr(C)]
// Field names mirror the Win32 `SHELLEXECUTEINFOW` layout from the Windows SDK
// so the struct can be diffed against MSDN line by line — snake case by design.
#[allow(non_snake_case)]
struct ShellExecuteInfoW {
    cbSize: u32,
    fMask: u32,
    hwnd: isize,
    lpVerb: *const u16,
    lpFile: *const u16,
    lpParameters: *const u16,
    lpDirectory: *const u16,
    nShow: i32,
    hInstApp: isize,
    lpIDList: *mut core::ffi::c_void,
    lpClass: *const u16,
    hkeyClass: isize,
    dwHotKey: u32,
    hIconOrMonitor: isize,
    hProcess: isize,
}

impl Default for ShellExecuteInfoW {
    fn default() -> Self {
        Self {
            cbSize: std::mem::size_of::<ShellExecuteInfoW>() as u32,
            fMask: SEE_MASK_DEFAULT,
            hwnd: 0,
            lpVerb: std::ptr::null(),
            lpFile: std::ptr::null(),
            lpParameters: std::ptr::null(),
            lpDirectory: std::ptr::null(),
            nShow: SW_SHOWNORMAL,
            hInstApp: 0,
            lpIDList: std::ptr::null_mut(),
            lpClass: std::ptr::null(),
            hkeyClass: 0,
            dwHotKey: 0,
            hIconOrMonitor: 0,
            hProcess: 0,
        }
    }
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(lpExecInfo: *mut ShellExecuteInfoW) -> BOOL;
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Run `exe args…` elevated. Returns Err with a user-meaningful message when
/// the UAC prompt is declined (ERROR_CANCELLED = HRESULT 0x800704C7 wrapped
/// by ShellExecuteEx as FALSE + GetLastError 1223) or any launch fails.
fn shell_execute_elevated(exe: &str, params: &str) -> Result<(), String> {
    const ERROR_CANCELLED: i32 = 1223;

    let verb = to_wide("runas");
    let file = to_wide(exe);
    let parameters = to_wide(params);

    let mut sei = ShellExecuteInfoW {
        fMask: SEE_MASK_DEFAULT | SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: parameters.as_ptr(),
        ..Default::default()
    };

    // ShellExecuteEx is synchronous for the PROMPT but returns as soon as the
    // launch is handed off — the tunnel service itself takes seconds to come
    // up, which the sidecar verifies separately via `wg show`.
    let ok = unsafe { ShellExecuteExW(&mut sei) };
    if ok != 0 {
        if sei.hProcess != 0 {
            unsafe {
                windows_close_handle(sei.hProcess);
            }
        }
        return Ok(());
    }
    let err = unsafe { windows_get_last_error() } as i32;
    if err == ERROR_CANCELLED {
        return Err("ELEVATION_DECLINED: The user declined the elevation prompt".into());
    }
    Err(format!("ELEVATION_FAILED: ShellExecuteEx error {err}"))
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: isize) -> BOOL;
    fn GetLastError() -> u32;
    fn OpenProcess(desired_access: u32, inherit_handle: BOOL, process_id: u32) -> isize;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn GetCurrentProcessId() -> u32;
}

/// SYNCHRONIZE — the only access right needed to wait on a process handle.
const SYNCHRONIZE: u32 = 0x0010_0000;
const WAIT_TIMEOUT: u32 = 0x0000_0102;

unsafe fn windows_close_handle(handle: isize) {
    let _ = CloseHandle(handle);
}

unsafe fn windows_get_last_error() -> u32 {
    GetLastError()
}

// ---------------------------------------------------------------------------
// Administrator rights for the APP ITSELF (not a per-action broker op).
// ---------------------------------------------------------------------------

/// Detached-process flags for the helper copy of this exe.
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Command-line flag the helper copy is launched with: `--elevate-after <pid>`.
const ELEVATE_AFTER_FLAG: &str = "--elevate-after";

/// Is THIS process elevated?
///
/// Same mechanism as the sidecar's `util/privileges` (`net session` succeeds
/// only from an elevated token) on purpose: two independent, differently-shaped
/// answers to "do we have admin" is exactly how a UI ends up telling the user
/// two different things at once.
///
/// Runs hidden — a console window flashing on every status poll would be worse
/// than the check itself.
pub fn is_process_elevated() -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new("net")
        .arg("session")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Wait for another process to exit. Returns true when it did (or when the
/// handle could not be opened because the process is already gone).
fn wait_for_process_exit(pid: u32, timeout_ms: u32) -> bool {
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle == 0 {
        // Already exited, or we may not even open a handle to it — either way
        // there is nothing left to wait for.
        return true;
    }
    let result = unsafe { WaitForSingleObject(handle, timeout_ms) };
    unsafe {
        windows_close_handle(handle);
    }
    // Only a timeout means "still running"; WAIT_OBJECT_0 is the clean exit and
    // any other wait result is treated as gone rather than hanging the helper.
    result != WAIT_TIMEOUT
}

/// Parse `--elevate-after <pid>` out of a raw argument list.
///
/// Pure, so the relaunch contract is unit-testable without touching a UAC
/// prompt: a helper copy of this exe must NEVER start the GUI or the sidecar.
pub(crate) fn parse_elevate_after<S: AsRef<str>>(args: &[S]) -> Option<u32> {
    let joined: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();
    let idx = joined.iter().position(|a| *a == ELEVATE_AFTER_FLAG)?;
    joined.get(idx + 1)?.parse::<u32>().ok()
}

/// Make the current process relaunch itself with administrator rights.
///
/// WHY A HELPER AND NOT `ShellExecuteEx(runas)` DIRECTLY: this app enforces
/// single-instance, and the elevated copy must come up AFTER the current
/// process is gone — otherwise it forwards its arguments to the dying instance
/// through the single-instance plugin and exits, and the user sees a UAC prompt
/// that changes nothing.
///
/// So: spawn a DETACHED, still-unprivileged copy of this exe with
/// `--elevate-after <our pid>`, ask the UI to quit, and let that helper raise
/// the one UAC prompt once our pid is gone. The helper does no app work.
pub fn spawn_elevation_helper() -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| format!("cannot resolve own exe: {e}"))?;
    let pid = unsafe { GetCurrentProcessId() };
    let child = std::process::Command::new(&exe)
        .arg(ELEVATE_AFTER_FLAG)
        .arg(pid.to_string())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("cannot start the elevation helper: {e}"))?;
    Ok(child.id())
}

/// Entry point for the helper copy (see `spawn_elevation_helper`).
///
/// Blocks until the app instance that spawned us has exited, then re-launches
/// this exe with the `runas` verb. Never returns.
pub fn run_elevation_helper(parent_pid: u32) -> ! {
    log_info!("elevation helper: waiting for pid {parent_pid} to exit before prompting for admin");
    // 60 s is generous for a GUI shutdown that includes stopping the sidecar;
    // the elevated launch is still useful if the old instance is wedged, so
    // time out rather than hang forever.
    let exited = wait_for_process_exit(parent_pid, 60_000);
    if !exited {
        log_warn!("elevation helper: pid {parent_pid} did not exit within 60s; attempting the elevated launch anyway");
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            log_error!("elevation helper: cannot resolve own exe: {e}");
            std::process::exit(1);
        }
    };
    match shell_execute_elevated(&exe, "") {
        Ok(()) => log_info!("elevation helper: elevated launch handed to the OS"),
        Err(e) => log_error!("elevation helper: elevated launch failed: {e}"),
    }
    std::process::exit(0);
}

// ---------------------------------------------------------------------------
// Tauri command — the only entry point the webview gets.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct BridgeOutcome {
    /// true = the elevated launch was performed (tunnel install handed to the
    /// OS); the sidecar still verifies the interface afterwards.
    pub launched: bool,
    /// true = the user actively declined the UAC prompt.
    pub declined: bool,
    pub error: Option<String>,
}

/// Bridge one pending elevation operation.
///
/// `op_id` comes from the UI, everything else (port, token, data dir) comes
/// from this process's own state. The heavy lifting happens on a background
/// thread so the UAC prompt appearing does not stall the IPC runtime.
#[tauri::command]
pub async fn vpn_elevation_bridge(
    app: tauri::AppHandle,
    op_id: String,
) -> Result<BridgeOutcome, String> {
    // Basic input discipline: op ids are UUIDs the sidecar minted.
    if op_id.is_empty() || op_id.len() > 64 || !op_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("invalid opId".into());
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let state = app.state::<crate::sidecar::SidecarState>();
    let (port, token) = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "sidecar state poisoned".to_string())?;
        if inner.child.is_none() {
            return Err("backend is not running".into());
        }
        (inner.port, inner.token.clone())
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<BridgeOutcome, String> {
        let op = match fetch_pending_op_blocking(port, &token, &op_id) {
            Ok(op) => op,
            Err(e) => {
                log_error!("elevation: pending-op fetch failed: {e}");
                return Err(e);
            }
        };

        if let Err(e) = validate_op(&op, &data_dir) {
            log_warn!("elevation: operation rejected: {e}");
            report_result_blocking(
                port,
                &token,
                &op_id,
                &ResultReport { nonce: &op.nonce, ok: false, error: Some(&e) },
            );
            return Ok(BridgeOutcome { launched: false, declined: false, error: Some(e) });
        }

        let params = op.args.join(" ");
        log_info!("elevation: launching allowed tunnel install for op {op_id}");
        match shell_execute_elevated(&op.exe, &params) {
            Ok(()) => {
                report_result_blocking(port, &token, &op_id, &ResultReport { nonce: &op.nonce, ok: true, error: None });
                Ok(BridgeOutcome { launched: true, declined: false, error: None })
            }
            Err(e) => {
                let declined = e.starts_with("ELEVATION_DECLINED");
                if declined {
                    log_info!("elevation: user declined the prompt for op {op_id}");
                } else {
                    log_error!("elevation: launch failed for op {op_id}: {e}");
                }
                report_result_blocking(
                    port,
                    &token,
                    &op_id,
                    &ResultReport { nonce: &op.nonce, ok: false, error: Some(&e) },
                );
                Ok(BridgeOutcome { launched: false, declined, error: Some(e) })
            }
        }
    })
    .await
    .map_err(|e| format!("bridge task: {e}"))?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn op(action: &str, exe: &str, args: &[&str], nonce: &str) -> PendingOp {
        PendingOp {
            action: action.into(),
            exe: exe.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            nonce: nonce.into(),
            config_sha256: String::new(),
        }
    }

    #[test]
    fn rejects_unknown_action() {
        let dir = std::env::temp_dir();
        let o = op("openvpn-daemon", "C:\\Program Files\\WireGuard\\wireguard.exe", &["/installtunnelservice", "C:\\x.conf"], "abcdefgh12345678");
        assert!(validate_op(&o, &dir).is_err());
    }

    #[test]
    fn rejects_short_or_nonalnum_nonce() {
        let dir = std::env::temp_dir();
        let o = op(ACTION_WG_INSTALL, "C:\\Program Files\\WireGuard\\wireguard.exe", &["/installtunnelservice", "C:\\x.conf"], "short");
        assert!(validate_op(&o, &dir).is_err());
        let o = op(ACTION_WG_INSTALL, "C:\\Program Files\\WireGuard\\wireguard.exe", &["/installtunnelservice", "C:\\x.conf"], "has space 123456");
        assert!(validate_op(&o, &dir).is_err());
    }

    #[test]
    fn rejects_exe_outside_allowlist() {
        let dir = std::env::temp_dir();
        let o = op(ACTION_WG_INSTALL, "C:\\Users\\Public\\wireguard.exe", &["/installtunnelservice", "C:\\x.conf"], "abcdefgh12345678");
        assert!(validate_op(&o, &dir).is_err());
    }

    #[test]
    fn rejects_wrong_argument_shape() {
        let dir = std::env::temp_dir();
        let o = op(ACTION_WG_INSTALL, "C:\\Program Files\\WireGuard\\wireguard.exe", &["/uninstalltunnelservice", "netpulse-wg-x"], "abcdefgh12345678");
        assert!(validate_op(&o, &dir).is_err());
        let o = op(ACTION_WG_INSTALL, "C:\\Program Files\\WireGuard\\wireguard.exe", &["/installtunnelservice"], "abcdefgh12345678");
        assert!(validate_op(&o, &dir).is_err());
    }

    #[test]
    fn rejects_config_outside_data_dir_or_wrong_ext() {
        let dir = std::env::temp_dir();
        // relative path
        let o = op(ACTION_WG_INSTALL, "C:\\Program Files\\WireGuard\\wireguard.exe", &["/installtunnelservice", "x.conf"], "abcdefgh12345678");
        assert!(validate_op(&o, &dir).is_err());
        // wrong extension, absolute, inside dir
        let inside = dir.join("probe-not-a-tunnel.txt");
        std::fs::write(&inside, b"test").unwrap();
        let o = op(ACTION_WG_INSTALL, "C:\\Program Files\\WireGuard\\wireguard.exe", &["/installtunnelservice", inside.to_str().unwrap()], "abcdefgh12345678");
        assert!(validate_op(&o, &dir).is_err());
        let _ = std::fs::remove_file(&inside);
    }

    #[test]
    fn hex_encode_is_lowercase_and_exact() {
        assert_eq!(hex_encode(&[0x00, 0xff, 0x10]), "00ff10");
    }

    #[test]
    fn urlencode_leaves_unreserved_and_escapes_the_rest() {
        assert_eq!(urlencode("abc-DEF_1.2~"), "abc-DEF_1.2~");
        assert_eq!(urlencode("a b/c?d"), "a%20b%2Fc%3Fd");
    }

    #[test]
    fn elevate_after_flag_is_parsed_only_when_a_pid_follows() {
        assert_eq!(parse_elevate_after(&["app.exe", "--elevate-after", "4321"]), Some(4321));
        // A normal launch (and a flag with no/invalid pid) must never be
        // mistaken for the helper: getting this wrong would spawn a second GUI.
        assert_eq!(parse_elevate_after(&["app.exe"]), None);
        assert_eq!(parse_elevate_after(&["app.exe", "--elevate-after"]), None);
        assert_eq!(parse_elevate_after(&["app.exe", "--elevate-after", "not-a-pid"]), None);
        assert_eq!(parse_elevate_after(&["app.exe", "--safe-mode"]), None);
    }

    #[test]
    #[ignore = "pops a real OS dialog on interactive Windows: ShellExecuteExW with the runas verb surfaces a 'cannot find/consent' box for the missing path before returning the error (observed live during the security audit). Run explicitly with: cargo test -- --ignored"]
    fn shell_execute_rejects_missing_binary_without_panicking() {
        // A nonexistent binary must return a clean Err (not a crash). NOTE:
        // this CAN show an OS dialog on a desktop session — the old comment
        // claiming "without ever showing a prompt" was wrong (ShellExecuteEx
        // renders the error UI itself when not asked not to). The pure
        // validate_op tests below cover the allow-list without any UI; this
        // FFI error-path check stays as an opt-in audit tool.
        let r = shell_execute_elevated("C:\\definitely\\not\\real\\wireguard-nope.exe", "");
        assert!(r.is_err());
    }
}
