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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A throwaway tree shaped like the real one:
    ///
    /// ```text
    /// <tmp>/np-reveal-<pid>-<tag>/app.netpulse.desktop/          <- the root
    /// <tmp>/np-reveal-<pid>-<tag>/app.netpulse.desktop/logs/      <- inside it
    /// <tmp>/np-reveal-<pid>-<tag>/app.netpulse.desktop/logs/netpulse.log
    /// <tmp>/np-reveal-<pid>-<tag>/app.netpulse.desktop-evil/     <- name-prefix sibling
    /// <tmp>/np-reveal-<pid>-<tag>/outside/
    /// ```
    ///
    /// `log` and `outside` deliberately exist, so a traversal that reaches them
    /// goes through real `canonicalize()` rather than the lexical fallback.
    struct Sandbox {
        base: PathBuf,
    }

    impl Sandbox {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!("np-reveal-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            for dir in [
                "app.netpulse.desktop",
                "app.netpulse.desktop/logs",
                "app.netpulse.desktop-evil",
                "outside",
            ] {
                std::fs::create_dir_all(base.join(dir)).expect("sandbox setup");
            }
            std::fs::write(base.join("app.netpulse.desktop/logs/netpulse.log"), b"boot ok\n")
                .expect("sandbox log");
            Sandbox { base }
        }

        fn root(&self) -> PathBuf {
            self.base.join("app.netpulse.desktop")
        }

        /// The allow-list as the command builds it: the app data dir alone.
        fn allowed(&self) -> Vec<PathBuf> {
            vec![self.root()]
        }

        fn sibling(&self) -> PathBuf {
            self.base.join("app.netpulse.desktop-evil")
        }

        fn outside(&self) -> PathBuf {
            self.base.join("outside")
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    /// Is `candidate` inside `root`, comparing resolved forms when both exist?
    ///
    /// When neither resolves, the lexical answer is the best available one —
    /// and it is sound here, because a path the OS cannot resolve is not a
    /// path Explorer can be made to open.
    fn inside(candidate: &Path, root: &Path) -> bool {
        match (candidate.canonicalize(), root.canonicalize()) {
            (Ok(c), Ok(r)) => c.starts_with(&r),
            _ => candidate.starts_with(root),
        }
    }

    // ---------------------------------------------------------------------
    // The happy path: what "Open Logs" is actually for.
    // ---------------------------------------------------------------------

    #[test]
    fn the_root_and_everything_under_it_is_revealable() {
        let s = Sandbox::new("inside");
        for wanted in [
            s.root(),
            s.root().join("logs"),
            s.root().join("logs").join("netpulse.log"),
        ] {
            assert_eq!(
                resolve_revealable(&wanted, &s.allowed()),
                Some(canonical_or_lexical(&wanted)),
                "{wanted:?} should be revealable"
            );
        }
    }

    #[test]
    fn a_traversal_that_stays_inside_the_root_is_still_revealable() {
        // Cleaning the path must not turn a legitimate request into a denial.
        let s = Sandbox::new("inside-traversal");
        let wanted = s.root().join("logs").join("..").join("logs");
        assert!(resolve_revealable(&wanted, &s.allowed()).is_some());
    }

    #[test]
    fn the_path_returned_is_the_resolved_one_not_the_input_string() {
        // Explorer must be handed what was validated, so a reparse point can
        // never be revealed through the name it was reached by.
        let s = Sandbox::new("resolved");
        let wanted = s.root().join("logs").join(".").join("netpulse.log");
        let got = resolve_revealable(&wanted, &s.allowed()).expect("inside the root");
        assert!(inside(&got, &s.root()), "{got:?} left the root");
    }

    // ---------------------------------------------------------------------
    // The name-prefix sibling: the classic string-starts_with bug.
    // ---------------------------------------------------------------------

    #[test]
    fn a_sibling_sharing_only_a_name_prefix_is_refused() {
        let s = Sandbox::new("sibling");
        let evil = s.sibling();

        // Guard the trap this depends on: compared as STRINGS the sibling does
        // start with the root, so a byte-prefix check would have allowed it.
        assert!(
            evil.to_string_lossy()
                .starts_with(s.root().to_string_lossy().as_ref()),
            "precondition: the sibling really does share a string prefix"
        );

        assert!(
            resolve_revealable(&evil, &s.allowed()).is_none(),
            "{evil:?} shares a name prefix with the root and must be refused"
        );
    }

    // ---------------------------------------------------------------------
    // Traversal. Both branches matter: `outside` exists (so `canonicalize`
    // runs) and the higher targets do not (so the lexical fallback runs).
    // ---------------------------------------------------------------------

    #[test]
    fn parent_traversal_into_an_existing_directory_is_refused() {
        let s = Sandbox::new("traverse");
        for wanted in [
            s.root().join("..").join("outside"),
            s.root().join("logs").join("..").join("..").join("outside"),
            s.root().join("logs").join("..").join("..").join("app.netpulse.desktop-evil"),
        ] {
            assert!(
                resolve_revealable(&wanted, &s.allowed()).is_none(),
                "traversal escaped via {wanted:?}"
            );
        }
    }

    #[test]
    fn parent_traversal_into_a_missing_path_is_refused() {
        // `canonicalize` cannot succeed here, so this exercises the lexical
        // cleaning path — the branch that runs for anything not yet created.
        let s = Sandbox::new("traverse-missing");
        for wanted in [
            s.root().join("..").join("..").join("..").join("Windows"),
            s.root().join("logs").join("..").join("..").join("..").join("..").join("System32"),
            s.root().join("..").join("..").join("etc"),
        ] {
            assert!(
                resolve_revealable(&wanted, &s.allowed()).is_none(),
                "lexical traversal escaped via {wanted:?}"
            );
        }
    }

    #[test]
    fn a_path_outside_the_allow_list_with_no_traversal_is_refused() {
        let s = Sandbox::new("outside");
        for wanted in [s.outside(), s.base.clone(), std::env::temp_dir()] {
            assert!(
                resolve_revealable(&wanted, &s.allowed()).is_none(),
                "{wanted:?} is outside the root and must be refused"
            );
        }
    }

    #[test]
    fn relative_paths_are_refused() {
        let s = Sandbox::new("relative");
        for wanted in [
            PathBuf::from("logs"),
            PathBuf::from("."),
            PathBuf::from(".."),
            PathBuf::from("app.netpulse.desktop/logs"),
        ] {
            assert!(
                resolve_revealable(&wanted, &s.allowed()).is_none(),
                "{wanted:?} is not absolute and must be refused"
            );
        }
    }

    #[test]
    fn an_empty_allow_list_refuses_everything() {
        let s = Sandbox::new("empty");
        assert!(resolve_revealable(&s.root(), &[]).is_none());
        assert!(resolve_revealable(&s.outside(), &[]).is_none());
    }

    /// A base directory that does not exist yet — the first-run case. The
    /// lexical fallback then compares an unresolved base against whatever
    /// `canonicalize` returned for the target, which on Windows never matches
    /// because of the `\\?\` verbatim form. That denies everything, which is
    /// the safe direction; this test pins the direction rather than the hope.
    #[test]
    fn a_missing_allow_list_base_denies_rather_than_allows() {
        let s = Sandbox::new("missing-base");
        let allowed = vec![s.base.join("not-created-yet")];
        for wanted in [
            s.root().join("logs"),
            s.outside(),
            std::env::temp_dir(),
        ] {
            let got = resolve_revealable(&wanted, &allowed);
            assert!(
                got.is_none(),
                "a base that does not exist must not admit {wanted:?} (got {got:?})"
            );
        }
    }

    // ---------------------------------------------------------------------
    // Encoded and separator tricks. `path` arrives over IPC as a plain string
    // and is never URL-decoded, so these are literal directory names — the
    // assertion that matters is that none of them escapes.
    // ---------------------------------------------------------------------

    #[test]
    fn url_encoded_traversal_is_never_decoded_into_an_escape() {
        let s = Sandbox::new("encoded");
        for wanted in [
            s.root().join("%2e%2e").join("%2e%2e").join("outside"),
            s.root().join("%2e%2e%2f%2e%2e%2foutside"),
            s.root().join("..%2f..%2foutside"),
            s.root().join("%00").join("..").join(".."),
        ] {
            let got = resolve_revealable(&wanted, &s.allowed());
            if let Some(resolved) = got {
                assert!(
                    inside(&resolved, &s.root()),
                    "{wanted:?} was decoded into an escape: {resolved:?}"
                );
            }
        }
    }

    #[test]
    fn forward_slashes_cannot_hide_traversal() {
        let s = Sandbox::new("fwd-slash");
        for wanted in [
            s.root().join("logs/../../outside"),
            s.root().join("logs/../../../outside"),
            s.root().join("logs/.."),
        ] {
            match resolve_revealable(&wanted, &s.allowed()) {
                None => {}
                Some(resolved) => assert!(
                    inside(&resolved, &s.root()),
                    "{wanted:?} escaped to {resolved:?}"
                ),
            }
        }
    }

    // ---------------------------------------------------------------------
    // The invariant, over everything at once: whatever comes back is inside.
    // ---------------------------------------------------------------------

    #[test]
    fn no_hostile_input_ever_resolves_outside_the_allow_list() {
        let s = Sandbox::new("invariant");
        let sep = std::path::MAIN_SEPARATOR;
        let root = s.root();
        let root_s = root.to_string_lossy();
        let hostile: Vec<PathBuf> = vec![
            // traversal in several spellings
            root.join("..").join("outside"),
            root.join("logs").join("..").join("..").join("outside"),
            PathBuf::from(format!("{root_s}{sep}logs{sep}..{sep}..{sep}outside")),
            PathBuf::from(format!("{root_s}{sep}..{sep}outside")),
            PathBuf::from(format!("{root_s}{sep}..{sep}..{sep}..{sep}Windows")),
            // name-prefix sibling, and its own traversal
            s.sibling(),
            s.sibling().join("..").join("outside"),
            // drive-relative, drive-root and UNC shapes
            PathBuf::from(format!("C:{sep}Windows")),
            PathBuf::from(format!("C:{sep}")),
            PathBuf::from(format!(r"\\?\C:{sep}Windows")),
            PathBuf::from(r"\\localhost\c$\Windows"),
            // not-a-path
            PathBuf::from(""),
            PathBuf::from(" "),
            // the root's own name used as a prefix on a longer sibling
            PathBuf::from(format!("{root_s}-evil")),
            PathBuf::from(format!("{root_s}2")),
        ];

        for wanted in hostile {
            if let Some(resolved) = resolve_revealable(&wanted, &s.allowed()) {
                panic!(
                    "ESCAPED: {wanted:?} resolved to {resolved:?}, which is outside {root:?}"
                );
            }
        }
    }

    // ---------------------------------------------------------------------
    // Windows-specific shapes. Exercised on this machine — see the reparse
    // point note below for the one case that is not.
    // ---------------------------------------------------------------------

    /// Win32 strips trailing dots and spaces from a component, so a component
    /// does not always name the directory it reads as. These are now refused
    /// outright by `has_trailing_dot_or_space`.
    ///
    /// The `assert!(root.join(".. ").exists())` below is the reason: Win32
    /// resolves that spelling to the root's PARENT, so before the fix the check
    /// admitted a path that Explorer would have opened outside the data root.
    #[cfg(windows)]
    #[test]
    fn trailing_dot_and_space_components_are_refused_outright() {
        let s = Sandbox::new("trailing");
        let sep = std::path::MAIN_SEPARATOR;
        let root = s.root();
        let root_s = root.to_string_lossy();

        // Why the refusal exists: this spelling is lexically inside the root
        // but Windows resolves it to the parent directory.
        assert!(
            root.join(".. ").exists(),
            "Windows no longer normalises the trailing space; revisit has_trailing_dot_or_space"
        );

        let hostile = [
            root.join(".. "),
            root.join(".. ."),
            root.join("..."),
            root.join("logs."),
            root.join("logs "),
            PathBuf::from(format!("{root_s}{sep}.. {sep}outside")),
            PathBuf::from(format!("{root_s}{sep}.. .{sep}outside")),
            PathBuf::from(format!("{root_s}{sep}logs{sep}.. {sep}.. {sep}outside")),
            PathBuf::from(format!("{root_s}{sep}logs{sep}.. .{sep}.. {sep}outside")),
            PathBuf::from(format!("{root_s}{sep}...{sep}outside")),
        ];
        for wanted in hostile {
            assert!(
                resolve_revealable(&wanted, &s.allowed()).is_none(),
                "{wanted:?} must be refused: Windows normalises it to a different directory"
            );
        }
    }

    /// The NTFS alternate-data-stream spelling, which is another way to write
    /// a component that does not name a directory. Same shape as above: the
    /// check admits it, the OS cannot resolve it, so nothing is revealed.
    #[cfg(windows)]
    #[test]
    fn alternate_data_stream_syntax_reaches_nothing_outside_the_root() {
        let s = Sandbox::new("ads");
        let sep = std::path::MAIN_SEPARATOR;
        let root = s.root();
        let root_s = root.to_string_lossy();
        let hostile = [
            PathBuf::from(format!("{root_s}{sep}outside::$DATA")),
            PathBuf::from(format!("{root_s}{sep}..::$DATA")),
            PathBuf::from(format!("{root_s}{sep}logs{sep}::$DATA")),
        ];
        for wanted in hostile {
            if resolve_revealable(&wanted, &s.allowed()).is_some() {
                assert!(
                    !wanted.exists(),
                    "the check admits {wanted:?} AND Windows resolves it — it can reach outside the root"
                );
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_path_spelled_with_different_casing_never_lands_outside() {
        let s = Sandbox::new("case");
        let shouted = PathBuf::from(s.root().to_string_lossy().to_uppercase());
        if let Some(resolved) = resolve_revealable(&shouted, &s.allowed()) {
            assert!(
                inside(&resolved, &s.root()),
                "a differently-cased request resolved outside the root: {resolved:?}"
            );
        }
    }

    /// The reparse-point case: a symlink or junction inside the root that
    /// points out of it must resolve to its target and be refused.
    ///
    /// **Not exercised in CI or on a standard developer account** — creating a
    /// directory symlink needs Developer Mode or elevation, and `mklink /J`
    /// needs a local volume. Run it explicitly with `cargo test -- --ignored`
    /// on a machine that allows it. The lexical branch above is what covers
    /// this case until then.
    #[test]
    #[ignore = "needs Developer Mode or elevation to create a directory symlink/junction"]
    fn a_reparse_point_inside_the_root_pointing_outside_is_refused() {
        let s = Sandbox::new("reparse");
        let link = s.root().join("escape");
        let target = s.outside();

        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&target, &link).expect("symlink creation should be permitted");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink creation should be permitted");

        assert!(
            resolve_revealable(&link, &s.allowed()).is_none(),
            "a reparse point inside the root must not resolve to a target outside it"
        );

        // And the same link pointing at something genuinely inside stays usable.
        let inner = s.root().join("inside-link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(s.root().join("logs"), &inner).expect("symlink");
        #[cfg(unix)]
        std::os::unix::fs::symlink(s.root().join("logs"), &inner).expect("symlink");
        assert!(resolve_revealable(&inner, &s.allowed()).is_some());
    }
}
