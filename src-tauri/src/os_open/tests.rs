use super::*;

// ---------------------------------------------------------------------
// open_external: the check between a UI action and a process launch.
//
// The validator is pure, so none of these spawn anything. Every negative
// below was confirmed to fail in the validator itself, not merely to fail
// to spawn.
// ---------------------------------------------------------------------

/// Anything the validator accepts is a plain https URL.
#[test]
fn an_https_url_is_allowed_and_normalised() {
    let url = validated_external_url("https://www.cloudflare.com").expect("https is allowed");
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("www.cloudflare.com"));
    // Normalised: the launched argument is this, never the raw input.
    assert_eq!(url.as_str(), "https://www.cloudflare.com/");
}

#[test]
fn scheme_and_host_case_and_missing_slashes_are_normalised_not_refused() {
    for (input, host) in [
        ("HTTPS://WWW.CLOUDFLARE.COM/Path", "www.cloudflare.com"),
        ("https:/www.cloudflare.com", "www.cloudflare.com"),
        ("https://www.cloudflare.com:8443/x?y=1#z", "www.cloudflare.com"),
    ] {
        let url = validated_external_url(input).unwrap_or_else(|e| panic!("{input:?}: {e}"));
        assert_eq!(url.scheme(), "https", "{input:?}");
        assert_eq!(url.host_str(), Some(host), "{input:?}");
    }
}

#[test]
fn plaintext_http_is_refused() {
    assert_eq!(
        validated_external_url("http://www.cloudflare.com"),
        Err("only https:// URLs can be opened".to_string())
    );
}

/// Schemes that would turn a link click into local file access, script
/// execution, or a network share open.
#[test]
fn dangerous_and_non_web_schemes_are_refused() {
    for input in [
        "file:///C:/Windows/System32/calc.exe",
        "file://server/share",
        "smb://server/share",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "ms-settings:privacy",
        "ms-msdt:/id",
        "about:blank",
        "view-source:https://www.cloudflare.com",
        "chrome://settings",
        "ftp://files.example.com/x",
    ] {
        assert_eq!(
            validated_external_url(input),
            Err("only https:// URLs can be opened".to_string()),
            "{input:?} must be refused"
        );
    }
}

/// A UNC path has no scheme at all, so it is refused by the parser before
/// the scheme check — there is no path by which it becomes a launch.
#[test]
fn a_unc_path_is_refused() {
    for input in [
        r"\\server\share\evil.txt",
        r"\\localhost\c$\Windows\System32",
        r"\\?\UNC\server\share",
    ] {
        assert!(validated_external_url(input).is_err(), "{input:?} must be refused");
    }
}

#[test]
fn a_windows_path_is_refused() {
    for input in [
        r"C:\Windows\System32\calc.exe",
        r"C:/Windows/System32/calc.exe",
        r"..\..\Windows\System32\cmd.exe",
    ] {
        assert!(validated_external_url(input).is_err(), "{input:?} must be refused");
    }
}

/// The PATH-resolution vector: a bare program name is not a URL, so it can
/// never reach the OS handler. Checked with names that really do resolve on
/// this machine, so the test would fail loudly if a bare name were ever
/// passed through to a process launch.
#[test]
fn a_bare_executable_name_is_refused_so_it_can_never_resolve_via_path() {
    for name in ["calc.exe", "cmd.exe", "powershell.exe", "explorer.exe", "notepad"] {
        let input = name.to_string();
        assert!(
            validated_external_url(&input).is_err(),
            "{name:?} must be refused: a bare name could resolve via PATH"
        );
    }
}

#[test]
fn urls_carrying_credentials_are_refused() {
    for input in [
        "https://user:pass@www.cloudflare.com",
        "https://user@www.cloudflare.com",
        "https://:pass@www.cloudflare.com",
        "https://user:@www.cloudflare.com",
    ] {
        assert_eq!(
            validated_external_url(input),
            Err("URLs containing credentials are not allowed".to_string()),
            "{input:?} must be refused"
        );
    }
}

/// An empty userinfo is not a credential, and the normalised URL drops it
/// — so nothing is ever handed to the browser in the authority.
#[test]
fn an_empty_userinfo_is_allowed_but_is_dropped_before_launch() {
    let url = validated_external_url("https://@www.cloudflare.com").expect("no credential present");
    assert_eq!(url.as_str(), "https://www.cloudflare.com/");
    assert!(!url.as_str().contains('@'));
}

// ---------------------------------------------------------------------
// Parser behaviour that a future change could get wrong. These are the
// cases where "what the user typed" and "what runs" are not the same
// string, so they are pinned deliberately.
// ---------------------------------------------------------------------

/// WHATWG parsing strips tab/CR/LF from anywhere in a URL, so
/// `www.cloud\r\nflare.com` becomes the host `www.cloudflare.com`. That is
/// a join, not an injection — and crucially the SAME normalised URL is what
/// gets validated and what gets launched, so there is nothing to smuggle.
#[test]
fn embedded_newlines_are_stripped_rather_than_splitting_the_host() {
    let url = validated_external_url("https://www.cloud\r\nflare.com").expect("stripped, not refused");
    assert_eq!(url.host_str(), Some("www.cloudflare.com"));
    assert_eq!(url.as_str(), "https://www.cloudflare.com/");
}

/// The invariant that makes the above safe: whatever the input, the string
/// handed to the OS handler contains no control character at all. If this
/// ever fails, a log line or an argv entry can be forged.
#[test]
fn no_allowed_url_reaches_the_launcher_with_a_control_character() {
    let allowed_and_refused = [
        "https://www.cloudflare.com\r\n",
        "https://www.cloud\r\nflare.com",
        "https://www.cloudflare.com\n/x",
        "https://www.cloudflare.com\t/x",
        "https://www.cloudflare.com?a=b&c=d",
        "https://user:pass@www.cloudflare.com",
        "https://www.cloudflare.com?q=<script>alert(1)</script>",
        "https://www.cloudflare.com/a b",
        "http://www.cloudflare.com\n",
        "javascript:alert(1)\n",
    ];
    for input in allowed_and_refused {
        if let Ok(url) = validated_external_url(input) {
            let launched = url.as_str();
            assert!(
                !launched.chars().any(|c| c.is_control()),
                "launched argument carries a control character: {launched:?} (from {input:?})"
            );
            assert!(!launched.contains('\r') && !launched.contains('\n'));
        }
    }
}

/// Percent-encoding in the path stays percent-encoded. It cannot become a
/// header break or a second request line in what the browser receives.
#[test]
fn percent_encoded_control_bytes_stay_encoded() {
    let url = validated_external_url("https://www.cloudflare.com/%0d%0aHost:%20evil").expect("a path is a path");
    let launched = url.as_str();
    assert!(launched.contains("%0d%0a"), "{launched:?}");
    assert!(!launched.contains('\r') && !launched.contains('\n'), "{launched:?}");
}

/// For https (a "special" scheme) WHATWG treats `\` as a path separator,
/// so `https://evil.com\@example.com` has host `evil.com`. Harmless here
/// because there is no host allow-list to bypass — but it is exactly the
/// input that defeats a naive string-based host check, so it is pinned
/// before someone adds one.
#[test]
fn a_backslash_before_an_at_sign_cannot_smuggle_a_host() {
    let smuggled = validated_external_url(r"https://evil.com\@example.com").expect("valid https");
    assert_eq!(smuggled.host_str(), Some("evil.com"));
    assert_eq!(smuggled.as_str(), "https://evil.com/@example.com");

    let reversed = validated_external_url(r"https://example.com\@evil.com").expect("valid https");
    assert_eq!(reversed.host_str(), Some("example.com"));
}

/// Three slashes: the empty authority is parsed as the host rather than
/// rejected, so this opens a (host-controlled) DNS name.
#[test]
fn an_empty_authority_becomes_the_host() {
    let url = validated_external_url("https:///nohost").expect("https is allowed");
    assert_eq!(url.host_str(), Some("nohost"));
}

/// Loopback, LAN and link-local addresses are permitted, deliberately: a
/// VPN client routinely sends users to a router admin page
/// (`https://192.168.1.1`), and the URL opens in the USER'S OWN browser,
/// not in the webview — so it is not an SSRF surface for this process. The
/// launch still cannot become anything but an https navigation.
#[test]
fn loopback_and_lan_addresses_are_permitted_by_design() {
    for input in [
        "https://127.0.0.1:8080/admin",
        "https://localhost:9090",
        "https://[::1]/",
        "https://192.168.1.1",
        "https://10.0.0.1",
        "https://169.254.169.254/latest/meta-data/",
    ] {
        let url = validated_external_url(input).unwrap_or_else(|e| panic!("{input:?}: {e}"));
        assert_eq!(url.scheme(), "https", "{input:?}");
        assert!(!url.as_str().starts_with("file:"), "{input:?}");
    }
}

// ---------------------------------------------------------------------
// Malformed input.
// ---------------------------------------------------------------------

#[test]
fn malformed_and_empty_urls_are_refused() {
    for input in [
        "",
        "not a url at all",
        "https://",
        "https:///",
        "https://www.cloudflare.com:99999",
        "://www.cloudflare.com",
        "ht!tps://www.cloudflare.com",
    ] {
        assert!(
            validated_external_url(input).is_err(),
            "{input:?} must be refused"
        );
    }
}

/// The scheme check is the first thing after parsing, so nothing that is
/// not https can reach the credential or host logic — and nothing at all
/// reaches a process launch.
#[test]
fn every_refusal_names_the_reason() {
    for input in ["http://x.com", "file:///c:/x", "javascript:1", "calc.exe", ""] {
        let err = validated_external_url(input).expect_err("must be refused");
        assert!(!err.is_empty(), "{input:?} was refused with an empty message");
    }
}

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

// ---------------------------------------------------------------------
// The handoff record: evidence for a test, never a journal.
//
// `NETPULSE_HANDOFF_RECORD` exists so `tests/navigation_webview.rs` can read
// each handoff as DATA — this URL, this layer, this outcome — instead of
// matching log phrases. It is unset in every normal run, and what that protects
// is not merely "no rows" but "no FILE": a durable file listing the URLs the
// app opened is a browsing record, and this product does not keep one. So the
// negatives below ARE the feature, and they are pinned from both sides — a
// configured path really does receive a row (without that, every negative here
// would also pass with the channel broken outright), and once the variable is
// unset or empty no file receives one anywhere the app could name by default.
//
// The app's durable location for a user is `%APPDATA%/<identifier>` — the same
// directory the log lives in — so this test points APPDATA at a scratch profile
// and CREATES that directory before the negative calls. A fallback that
// invented a path would otherwise fail on a missing parent, and "nothing
// appeared" would then be true for the wrong reason. `with_appdata` also holds
// the process-wide environment lock, so this case cannot run beside the other
// env-reading tests in this binary.
// ---------------------------------------------------------------------

/// The file's bytes, or `None` when it does not exist.
///
/// The negatives below compare BYTES, so an append, a rewrite and a truncation
/// all fail the same assertion a missing row would — "still one row" must not
/// be satisfiable by rewriting the file.
fn record_file(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

/// An empty scratch directory named for this process and case.
fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("np-record-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

#[test]
fn a_handoff_records_nothing_once_the_record_variable_is_unset() {
    let profile = scratch("unset");
    crate::paths::tests::with_appdata(Some(&profile.to_string_lossy()), || {
        let data_dir = crate::paths::data_dir_without_handle()
            .expect("a scratch APPDATA resolves to the app's data dir");
        assert!(
            data_dir.starts_with(&profile),
            "{data_dir:?} is not inside the scratch profile {profile:?} — the assertions below \
             would be about a stranger's directory"
        );
        std::fs::create_dir_all(&data_dir).expect("create the scratch data dir");

        // What a reader would find there — the whole point of the negatives, so
        // a failure names the files rather than a count.
        let data_dir_entries = || {
            let mut names: Vec<String> = std::fs::read_dir(&data_dir)
                .expect("read the scratch data dir")
                .filter_map(|entry| entry.ok().map(|e| e.file_name().to_string_lossy().to_string()))
                .collect();
            names.sort();
            names
        };

        let configured = profile.join("configured.jsonl");
        let command_url = validated_external_url("https://example.com/").expect("valid https");

        // Positive control. WITH the variable set, one call writes exactly one
        // row, carrying the fields the real-webview test reads as data. Without
        // this, every assertion below would also pass if recording were broken
        // altogether — a test that only ever proves an ABSENCE proves nothing.
        std::env::set_var(HANDOFF_RECORD_ENV, &configured);
        record_handoff(&command_url, HandoffSource::Command, true);
        let after_set = record_file(&configured).expect("a configured path receives the row");
        let text = String::from_utf8(after_set.clone()).expect("the record is UTF-8");
        let row: serde_json::Value = serde_json::from_str(text.trim_end()).expect("one JSON row");
        assert_eq!(row["url"], serde_json::json!("https://example.com/"), "{text:?}");
        assert_eq!(row["host"], serde_json::json!("example.com"), "{text:?}");
        assert_eq!(row["source"], serde_json::json!("command"), "{text:?}");
        assert_eq!(row["ok"], serde_json::json!(true), "{text:?}");
        assert_eq!(text.lines().count(), 1, "one handoff writes one row: {text:?}");

        // 1. UNSET. The handoff itself still happens (this is only the record of
        //    it), and nothing is written: not to the file the app was just told
        //    to use — a cached path (a `OnceLock`, a static, a field that outlives
        //    the variable) keeps writing there and fails right here — and not to
        //    the profile's data dir, which is where a fallback would land.
        //    Each negative call uses a DIFFERENT url and layer, so any write at
        //    all changes the bytes rather than adding a row identical to the
        //    first one.
        let navigation_url =
            validated_external_url("https://example.net/navigation").expect("valid https");
        std::env::remove_var(HANDOFF_RECORD_ENV);
        record_handoff(&navigation_url, HandoffSource::Navigation, true);
        assert_eq!(
            record_file(&configured),
            Some(after_set.clone()),
            "a handoff was recorded after the variable was unset — an unset variable must \
             end the record channel, not fall back to a remembered path"
        );
        assert!(
            data_dir_entries().is_empty(),
            "an unset variable still wrote into the app's data dir {:?}: {:?}",
            data_dir,
            data_dir_entries()
        );

        // 2. EMPTY is not a path either. It is the value that makes a relative or
        //    parent-less write look attractive to an implementation, and the one
        //    an operator would produce by unsetting a variable the wrong way.
        let new_window_url =
            validated_external_url("https://example.org/new-window").expect("valid https");
        std::env::set_var(HANDOFF_RECORD_ENV, "");
        record_handoff(&new_window_url, HandoffSource::NewWindow, true);
        assert_eq!(
            record_file(&configured),
            Some(after_set),
            "an empty value was treated as a path"
        );
        assert!(
            data_dir_entries().is_empty(),
            "an empty value still wrote into the app's data dir {:?}: {:?}",
            data_dir,
            data_dir_entries()
        );

        // Leave the process as we found it: a record channel left configured
        // would be inherited by every test that runs after this one.
        std::env::remove_var(HANDOFF_RECORD_ENV);
    });
    let _ = std::fs::remove_dir_all(&profile);
}

/// The same guarantee at the boundary a user action actually crosses.
///
/// The case above calls `record_handoff` directly, which pins the writer but
/// not the command: a write added between `open_external` and the handoff
/// would leave that test green. This one drives the real command through the
/// debug-only launch seam (no browser is started) and checks that the command
/// still succeeds, reaches the launch point every time, and creates no file
/// once the record variable is unset or empty. The positive control again runs
/// first, so a broken record channel cannot make the negatives pass.
#[test]
fn the_open_external_command_keeps_no_journal_when_the_record_channel_is_off() {
    let profile = scratch("command-boundary");
    crate::paths::tests::with_appdata(Some(&profile.to_string_lossy()), || {
        let data_dir = crate::paths::data_dir_without_handle()
            .expect("a scratch APPDATA resolves to the app's data dir");
        assert!(
            data_dir.starts_with(&profile),
            "{data_dir:?} is not inside the scratch profile {profile:?} — the assertions below \
             would be about a stranger's directory"
        );
        std::fs::create_dir_all(&data_dir).expect("create the scratch data dir");

        let data_dir_entries = || {
            let mut names: Vec<String> = std::fs::read_dir(&data_dir)
                .expect("read the scratch data dir")
                .filter_map(|entry| entry.ok().map(|e| e.file_name().to_string_lossy().to_string()))
                .collect();
            names.sort();
            names
        };

        let configured = profile.join("command-configured.jsonl");
        let _seam = ExternalLaunchSeam::disabled();

        // Positive control THROUGH THE COMMAND. One row, command source, and
        // the seam was reached — otherwise the negatives below could pass by
        // short-circuiting the launch before the handoff site.
        std::env::set_var(HANDOFF_RECORD_ENV, &configured);
        open_external("https://example.com/command".to_string())
            .expect("the command accepts a validated https URL");
        let after_set = record_file(&configured).expect("the command writes one row when configured");
        let text = String::from_utf8(after_set.clone()).expect("the record is UTF-8");
        let row: serde_json::Value = serde_json::from_str(text.trim_end()).expect("one JSON row");
        assert_eq!(row["url"], serde_json::json!("https://example.com/command"), "{text:?}");
        assert_eq!(row["host"], serde_json::json!("example.com"), "{text:?}");
        assert_eq!(row["source"], serde_json::json!("command"), "{text:?}");
        assert_eq!(row["ok"], serde_json::json!(true), "{text:?}");
        assert_eq!(text.lines().count(), 1, "one command handoff writes one row: {text:?}");
        assert_eq!(ExternalLaunchSeam::skipped(), 1, "the command must reach the launch point");
        assert!(
            data_dir_entries().is_empty(),
            "a configured command wrote into the app's data dir {:?}: {:?}",
            data_dir,
            data_dir_entries()
        );

        // UNSET: the command keeps working, and the only file that changes is
        // the one it was explicitly told to use. The data dir stays empty.
        std::env::remove_var(HANDOFF_RECORD_ENV);
        open_external("https://example.net/after-unset".to_string())
            .expect("an unset record variable must not fail the handoff");
        assert_eq!(
            record_file(&configured),
            Some(after_set.clone()),
            "the open_external command wrote a row after the variable was unset"
        );
        assert!(
            data_dir_entries().is_empty(),
            "an unset variable still left a file in the app's data dir {:?}: {:?}",
            data_dir,
            data_dir_entries()
        );
        assert_eq!(ExternalLaunchSeam::skipped(), 2, "the second command must reach the launch point");

        // EMPTY: not a path, and not a fallback either.
        std::env::set_var(HANDOFF_RECORD_ENV, "");
        open_external("https://example.org/after-empty".to_string())
            .expect("an empty record variable must not fail the handoff");
        assert_eq!(
            record_file(&configured),
            Some(after_set),
            "the open_external command treated an empty value as a path"
        );
        assert!(
            data_dir_entries().is_empty(),
            "an empty value still left a file in the app's data dir {:?}: {:?}",
            data_dir,
            data_dir_entries()
        );
        assert_eq!(ExternalLaunchSeam::skipped(), 3, "all three commands must reach the launch point");

        std::env::remove_var(HANDOFF_RECORD_ENV);
    });
    let _ = std::fs::remove_dir_all(&profile);
}
