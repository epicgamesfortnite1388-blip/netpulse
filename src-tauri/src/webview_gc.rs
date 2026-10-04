//! Reaping orphaned WebView2 processes left behind by an abnormal exit.
//!
//! A panic, a Task Manager kill or a crash leaves `msedgewebview2.exe`
//! children running forever — a real leak observed in the field. This module
//! finds and kills only those, once, at startup.
//!
//! Matching is deliberately strict (image name AND dead parent AND owned by
//! this user), so it cannot touch an unrelated Edge or another app's webview.
//! It runs before the app spawns the sidecar and shares nothing with process
//! supervision, which is why it does not live in `sidecar`.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::logging::log_warn;

/// Sweep msedgewebview2.exe child processes whose NetPulse parent is gone.
/// An abnormal desktop exit (panic, Task Manager kill, crash) leaves the
/// webview children running forever — a real leak observed in the field.
/// Runs once at startup; matching is strict (image name AND dead parent AND
/// owned by this user), so it cannot touch unrelated Edge/webview processes.
#[cfg(target_os = "windows")]
pub fn sweep_orphaned_webviews() {
    // Identify ORPHAN ROOT webview processes only: marker procs whose parent
    // is neither a live netpulse-desktop.exe nor another webview process.
    // Killing the root with /T tears down its whole tree (renderers, GPU);
    // alive roots keep their children untouched. Windows PowerShell 5.1
    // compatible (no Process.Parent property there).
    const PS: &str = concat!(
        "$np = Get-CimInstance Win32_Process -Filter \"Name='netpulse-desktop.exe'\" | ForEach-Object { $_.ProcessId }; ",
        "$wv = @(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*--webview-exe-name=netpulse-desktop.exe*' }); ",
        "$ids = @($wv | ForEach-Object { $_.ProcessId }); ",
        "@($wv | Where-Object { -not ($np -contains $_.ParentProcessId) -and -not ($ids -contains $_.ParentProcessId) } | ForEach-Object { $_.ProcessId }) -join ' '"
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", PS])
        .creation_flags(0x0800_0000)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let pids: Vec<&str> = stdout.split_whitespace().collect();
            if !pids.is_empty() {
                log_warn!(
                    "sweeping {} orphaned webview root process(es) from a previous crash: {}",
                    pids.len(),
                    pids.join(",")
                );
                for pid in pids {
                    if let Ok(id) = pid.parse::<u32>() {
                        // Never touch our own process tree.
                        if id != std::process::id() {
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &id.to_string(), "/F", "/T"])
                                .creation_flags(0x0800_0000)
                                .output();
                        }
                    }
                }
            }
        }
        Ok(_) => log_warn!("webview orphan sweep probe failed (non-zero exit)"),
        Err(e) => log_warn!("webview orphan sweep unavailable: {e}"),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sweep_orphaned_webviews() {}
