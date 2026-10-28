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
///
/// `pub(crate)` because the navigation backstop (`navigation.rs`) asks this same
/// question of a URL the webview tried to follow. One validator, one answer: a
/// link the backstop opens is exactly a link the command would have opened.
pub(crate) fn validated_external_url(url: &str) -> Result<tauri::Url, String> {
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

/// Which exit asked for a handoff.
///
/// Recorded per handoff (see `record_handoff`), so the real-webview test can
/// tell the exits apart from DATA — this layer, that URL, this outcome — instead
/// of inferring it from log wording, which made every message a contract.
#[derive(Clone, Copy)]
pub(crate) enum HandoffSource {
    /// The `open_external` command: a page that routed the link through the guard
    /// in `apps/web/src/lib/externalNavigation.ts`.
    Command,
    /// The `on_navigation` backstop in `window.rs`.
    Navigation,
    /// The `on_new_window` backstop in `window.rs`.
    NewWindow,
}

impl HandoffSource {
    fn as_str(self) -> &'static str {
        match self {
            HandoffSource::Command => "command",
            HandoffSource::Navigation => "navigation",
            HandoffSource::NewWindow => "new-window",
        }
    }
}

/// The environment variable naming the file handoffs are recorded into.
///
/// **Unset in every normal run, on purpose.** A durable journal of the URLs the
/// app opened is a browsing record, and this product does not keep one; the
/// variable exists so `tests/navigation_webview.rs` can read a handoff as data
/// (URL, layer, spawn outcome) rather than matching log phrases. The test points
/// it at a temp file and deletes it when the run passes.
const HANDOFF_RECORD_ENV: &str = "NETPULSE_HANDOFF_RECORD";

/// Open an https URL in the user's default browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let parsed = validated_external_url(&url)?;
    launch_external(&parsed, HandoffSource::Command)
}

/// Open a URL that did not arrive through the `open_external` command.
///
/// Used by the navigation backstop, which sees the URLs the page never routed
/// through the JS guard. It re-validates the URL instead of trusting the
/// caller, so both entry points share one allow-list and one launch path.
pub(crate) fn open_external_url(url: &tauri::Url, source: HandoffSource) -> Result<(), String> {
    let parsed = validated_external_url(url.as_str())?;
    launch_external(&parsed, source)
}

/// Log and hand an already-validated URL to the platform's browser.
///
/// The `opening external link for host …` line is a diagnostic for a human
/// reading the log. The *evidence* a test can assert on is the record written by
/// `record_handoff` below — URL, source and outcome as data — so rewording this
/// message no longer breaks anything.
fn launch_external(parsed: &tauri::Url, source: HandoffSource) -> Result<(), String> {
    let host = parsed.host_str().unwrap_or("");
    crate::logging::log_info!("opening external link for host {host}");

    let launched = spawn_external(parsed);
    // Recorded AFTER the attempt, so a row means the OS was really asked, not
    // that the app intended to ask.
    record_handoff(parsed, source, launched.is_ok());
    launched
}

/// Debug-only seam that replaces the OS launch in tests.
///
/// The no-journal guarantee has to be pinned at the `open_external` command
/// boundary, not only at `record_handoff`: a caller could add a write on the
/// way in. Exercising the command for real would open a browser, so tests set
/// this thread-local to a function that records the call and returns success.
/// It is compiled into test and debug builds only — a release binary has no
/// seam and always reaches the platform handler.
#[cfg(any(test, debug_assertions))]
type ExternalLaunch = fn(&tauri::Url) -> Result<(), String>;

#[cfg(any(test, debug_assertions))]
thread_local! {
    static EXTERNAL_LAUNCH_SEAM: std::cell::Cell<Option<ExternalLaunch>> =
        const { std::cell::Cell::new(None) };
}

// Counts calls the seam short-circuited, so a test can prove the command
// actually reached the launch point instead of being skipped upstream.
#[cfg(test)]
thread_local! {
    static EXTERNAL_LAUNCHES_SKIPPED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn skip_external_launch(_: &tauri::Url) -> Result<(), String> {
    EXTERNAL_LAUNCHES_SKIPPED.with(|count| count.set(count.get() + 1));
    Ok(())
}

/// Installs the launch seam for as long as this guard lives. Restores the real
/// launch even if the test panics, so a neighbouring case cannot inherit it.
#[cfg(test)]
pub(crate) struct ExternalLaunchSeam;

#[cfg(test)]
impl ExternalLaunchSeam {
    pub(crate) fn disabled() -> Self {
        EXTERNAL_LAUNCHES_SKIPPED.with(|count| count.set(0));
        EXTERNAL_LAUNCH_SEAM.with(|launch| launch.set(Some(skip_external_launch)));
        Self
    }

    pub(crate) fn skipped() -> usize {
        EXTERNAL_LAUNCHES_SKIPPED.with(std::cell::Cell::get)
    }
}

#[cfg(test)]
impl Drop for ExternalLaunchSeam {
    fn drop(&mut self) {
        EXTERNAL_LAUNCH_SEAM.with(|launch| launch.set(None));
    }
}

/// Hand the validated URL to the platform's protocol handler — no shell in the
/// chain, so URL metacharacters can never reach a command interpreter.
fn spawn_external(parsed: &tauri::Url) -> Result<(), String> {
    #[cfg(any(test, debug_assertions))]
    if let Some(launch) = EXTERNAL_LAUNCH_SEAM.with(std::cell::Cell::get) {
        return launch(parsed);
    }

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

/// Append one JSON object per handoff to the file named by the environment, when
/// one is set. One object per line, so a reader can consume it while the app is
/// still running:
///
/// ```text
/// {"at":1793051965259,"url":"https://example.com/","host":"example.com","source":"command","ok":true}
/// ```
///
/// A missing configuration or an unwritable file must never fail a handoff: this
/// is evidence for a test, not user-visible behaviour.
fn record_handoff(parsed: &tauri::Url, source: HandoffSource, ok: bool) {
    let Some(path) = std::env::var_os(HANDOFF_RECORD_ENV) else {
        return;
    };
    if path.is_empty() {
        return;
    }

    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut line = serde_json::json!({
        "at": at,
        "url": parsed.as_str(),
        "host": parsed.host_str().unwrap_or(""),
        "source": source.as_str(),
        "ok": ok,
    })
    .to_string();
    line.push('\n');

    use std::io::Write;
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(line.as_bytes()));
    if let Err(e) = written {
        crate::logging::log_warn!(
            "handoff record not written to {}: {e}",
            path.to_string_lossy()
        );
    }
}

#[cfg(test)]
pub(crate) mod tests;
