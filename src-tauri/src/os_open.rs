//! The only two places the webview can make the OS do something.
//!
//! Both take untrusted input from the webview, validate it against an
//! allow-list the app itself defines, and hand it to the OS **without any
//! shell** — no `cmd`/`bash` interpreter is ever in the chain, so URL and path
//! metacharacters cannot reach a command interpreter.
//!
//!   - `reveal_path` — a directory inside the app's own data/log dirs only.
//!   - `open_external` — https only, no credentials, host required.
//!
//! Both decisions are pure functions (`resolve_revealable`, `validated_external_url`)
//! so the allow-lists are unit-tested directly rather than through the command.
//!
//! **What the URL allow-list was verified to refuse:** every non-https scheme
//! (`file:`, `smb:`, `javascript:`, `data:`, `vbscript:`, `ms-settings:`, …),
//! plaintext `http:`, UNC paths, Windows paths, bare program names, and any
//! authority carrying credentials. Two parser behaviours are pinned by tests
//! because they decide what the OS actually receives:
//!   - WHATWG parsing strips tab/CR/LF from anywhere in a URL, so
//!     `https://www.cloud\r\nflare.com` has the host `www.cloudflare.com`.
//!   - for https (a "special" scheme) `\` is a path separator, so
//!     `https://evil.com\@example.com` has the host `evil.com`. Harmless while
//!     there is no host allow-list, and pinned so that adding one by string
//!     comparison cannot be fooled by it.
//!
//! In both cases the SAME normalised URL is what is validated and what is
//! launched, so neither can be used to smuggle a different destination.
//!
//! `reveal_path`'s security decision lives in `resolve_revealable`, a pure
//! function with no `AppHandle` and no process spawn, so it is unit-tested
//! directly rather than through the command.
//!
//! **Windows behaviour worth knowing before changing the check.** `PathBuf::canonicalize`
//! returns the `\\?\` verbatim form, so a resolved path and an unresolved one
//! never compare equal even when they name the same directory. That only ever
//! *denies* (a base directory that does not exist yet, i.e. a first run, cannot
//! match anything), which is the safe direction — but it means "allowed" is
//! stricter on a fresh profile than the code looks like it should be.

use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Ask the OS to reveal a path in the file manager (used by "Open Logs").
///
/// Security: the webview may only reveal the app's own data/log directories.
/// The allow-list is enforced by `resolve_revealable`, which canonicalizes
/// before comparing so `..` traversal, reparse-point games and UNC tricks
/// cannot escape it.
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

    match resolve_revealable(&requested, &allowed) {
        Some(target) => spawn_reveal(&target),
        None => Err("path is outside the app's allowed directories".into()),
    }
}

/// The path that would actually be revealed, or `None` when `requested` is not
/// inside one of `allowed`.
///
/// The returned path is the *resolved* one, not the string that came in, so
/// Explorer is always pointed at the target that was validated — a reparse
/// point inside the root that points out of it resolves out and is refused.
fn resolve_revealable(requested: &Path, allowed: &[PathBuf]) -> Option<PathBuf> {
    if !requested.is_absolute() || allowed.is_empty() {
        return None;
    }
    if has_trailing_dot_or_space(requested) {
        return None;
    }
    let canonical = canonical_or_lexical(requested);
    let ok = allowed.iter().any(|base| match base.canonicalize() {
        Ok(resolved) => canonical.starts_with(&resolved),
        // Base dir may not exist yet on first run — compare lexically.
        Err(_) => canonical.starts_with(base),
    });
    ok.then_some(canonical)
}

/// Does any component carry a trailing dot or space?
///
/// **Windows only, and this closes a real escape.** Win32 silently strips those
/// characters from a component before opening it, so a component does not always
/// name the directory it reads as. Verified on Windows: `<root>\.. ` is lexically
/// inside `<root>` and so passed the check, but Win32 resolves it to `<root>`'s
/// PARENT — Explorer would have opened a directory outside the data root.
///
/// Reimplementing that normalization (and its reserved-name rules) to normalise
/// instead of reject would mean trusting rules this test suite cannot fully
/// exercise, so the ambiguous shapes are refused outright. Nothing the app
/// creates carries a trailing dot or space — its directories are the app data
/// dir, `logs`, and `backend/drizzle` — so the cost is a denial on a path we
/// could not reason about, which is the safe direction. On other platforms
/// trailing dots and spaces are ordinary characters and are left alone.
#[cfg(windows)]
fn has_trailing_dot_or_space(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .as_encoded_bytes()
            .last()
            .is_some_and(|b| *b == b'.' || *b == b' '),
        _ => false,
    })
}

#[cfg(not(windows))]
fn has_trailing_dot_or_space(_path: &Path) -> bool {
    false
}

/// Best-effort canonicalization (resolves `..`, reparse points, and `8.3`
/// short names where the target exists); fall back to lexical cleaning for
/// not-yet-created paths.
fn canonical_or_lexical(requested: &Path) -> PathBuf {
    requested.canonicalize().unwrap_or_else(|_| {
        let mut comps: std::collections::VecDeque<Component> = requested.components().collect();
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
    })
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

/// Validate a webview-supplied URL before it is handed to the OS.
///
/// Pure — no process is spawned here, so the allow-list is unit-testable
/// directly. `open_external` launches exactly the normalised URL this returns,
/// never the raw input string.
///
/// Security: strict allowlist — https scheme only, no userinfo/credentials,
/// host required. Opened via the OS protocol handler WITHOUT any shell
/// (no cmd/bash interpreter in the chain), so URL metacharacters can never
/// reach a command interpreter.
fn validated_external_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only https:// URLs can be opened".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs containing credentials are not allowed".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() {
        // Belt and braces: for https (a "special" scheme) the parser already
        // rejects an empty authority with "empty host", so this cannot fire.
        // It costs nothing and the failure it guards — handing the OS handler
        // a URL with no destination — is not worth depending on a parser
        // detail for. No test distinguishes it; that is deliberate, not an
        // oversight.
        return Err("URL has no host".into());
    }
    Ok(parsed)
}

/// Open an https URL in the user's default browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let parsed = validated_external_url(&url)?;
    let host = parsed.host_str().unwrap_or("");
    crate::logging::log_info!("opening external link for host {host}");

    #[cfg(target_os = "windows")]
    {
        // FileProtocolHandler dispatches to the default browser directly.
        // `parsed.as_str()` is the VALIDATED, normalised URL — never the raw
        // `url` argument. No shell is involved, so an argument can never reach
        // a command interpreter either way.
        //
        // Coverage note: the tests pin what `as_str()` produces (including that
        // it can never contain a control character), but this wiring — using
        // `parsed` rather than `url` here — is not covered by any test, because
        // exercising it means launching a real browser. Mutation-testing
        // confirmed changing it to `url.as_str()` fails nothing.
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

#[cfg(test)]
pub(crate) mod tests;
