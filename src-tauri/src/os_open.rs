//! The only two places the webview can make the OS do something.
//!
//! Both take untrusted input from the webview, validate it against an
//! allow-list the app itself defines, and hand it to the OS **without any
//! shell** — no `cmd`/`bash` interpreter is ever in the chain, so URL and path
//! metacharacters cannot reach a command interpreter.
//!
//!   - `reveal_path` — a directory inside the app's own data/log dirs only.
//!   - `open_external` — https only, no credentials, host required.

use std::path::{Component, PathBuf};

use tauri::{AppHandle, Manager};

/// Ask the OS to reveal a path in the file manager (used by "Open Logs").
///
/// Security: the webview may only reveal the app's own data/log directories.
/// The allow-list is enforced with canonicalized prefix matching, so `..`
/// traversal, symlink games and UNC tricks cannot escape it.
#[tauri::command]
pub fn reveal_path(path: String, app: AppHandle) -> Result<(), String> {
    let requested = PathBuf::from(&path);
    if !requested.is_absolute() {
        return Err("path must be absolute".into());
    }

    // Build the allow-list from the same dirs the app itself uses.
    let mut allowed: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        allowed.push(dir);
    }
    if let Ok(dir) = app.path().app_log_dir() {
        allowed.push(dir);
    }
    if allowed.is_empty() {
        return Err("no allowed reveal directories available".into());
    }

    // Best-effort canonicalization (resolves `..`, symlinks where the target
    // exists); fall back to lexical cleaning for not-yet-created paths.
    let canonical = requested.canonicalize().unwrap_or_else(|_| {
        let mut comps: std::collections::VecDeque<Component> =
            requested.components().collect();
        let mut out = PathBuf::new();
        while let Some(c) = comps.pop_front() {
            match c {
                Component::CurDir => {}
                Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    });

    let ok = allowed.iter().any(|base| match base.canonicalize() {
        Ok(b) => canonical.starts_with(&b),
        // Base dir may not exist yet on first run — compare lexically.
        Err(_) => canonical.starts_with(base),
    });
    if !ok {
        return Err("path is outside the app's allowed directories".into());
    }

    spawn_reveal(&canonical)
}

/// Open a directory with the platform's file manager (reveal, never execute).
fn spawn_reveal(canonical: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer with a validated absolute path; no shell involved.
        std::process::Command::new("explorer")
            .arg(canonical)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        // `open -R` reveals in Finder without executing the target.
        std::process::Command::new("open")
            .arg("-R")
            .arg(canonical)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(canonical)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open an https URL in the user's default browser.
///
/// Security: strict allowlist — https scheme only, no userinfo/credentials,
/// host required. Opened via the OS protocol handler WITHOUT any shell
/// (no cmd/bash interpreter in the chain), so URL metacharacters can never
/// reach a command interpreter.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only https:// URLs can be opened".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs containing credentials are not allowed".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("URL has no host".into());
    }
    crate::sidecar::log_info!("opening external link for host {host}");

    #[cfg(target_os = "windows")]
    {
        // FileProtocolHandler dispatches to the default browser directly.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", parsed.as_str()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
