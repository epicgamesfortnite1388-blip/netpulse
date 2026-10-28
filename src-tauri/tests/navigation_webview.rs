//! The navigation backstop, exercised through a REAL webview.
//!
//! `navigation::classify` is unit-tested as a pure function, and that is the
//! right place for the rule. What a unit test cannot see is the half that makes
//! the rule a backstop at all: the builder's `on_navigation` / `on_new_window`
//! closures in `window::create_main_window`, and the fact that the engine asks
//! them before it acts. Tauri's `mock_builder` runtime never navigates — by
//! design it has no engine to refuse — so an in-process test would exercise the
//! policy a second time and the wiring not at all.
//!
//! So this test drives the built application through `tauri-driver`, Tauri's
//! WebDriver harness, which puts the real WebView2 (Windows) / WebKitGTK
//! (Linux) window under WebDriver control. It then exercises every exit that can
//! hand a link to the OS, each one through the layer that really takes it:
//!
//!   1. `location.href = 'https://example.com/'` — an engine-initiated
//!      navigation, the shape a redirect or injected script takes. The Rust
//!      `on_navigation` backstop sees it.
//!   2. `window.open('https://example.com/')` — a new-window request. The Rust
//!      `on_new_window` backstop sees it.
//!   3. a click on a raw anchor injected into the page — the in-page guard in
//!      `externalNavigation.ts`, which the Rust backstop never sees because the
//!      guard calls `preventDefault()` and invokes the `open_external` command
//!      before the engine has a navigation to ask about.
//!
//! Each must be refused while the window stays on the app document, and the OS
//! must be asked to open the URL; an in-app route change must still work
//! afterwards, and a plaintext `http://` navigation must be refused *without*
//! launching anything. Together that proves a policy rather than a blanket
//! block.
//!
//! (1) and (2) are exits no DOM event describes. (3) is the one a DOM event
//! does describe, and the jsdom suites own its *decisions*
//! (`apps/web/test/externalNavigation.test.ts` asserts `preventDefault()` plus
//! `openExternalUrl` with the opener mocked). What only a real engine can show
//! is the wiring underneath: that a genuine input event on a raw anchor reaches
//! the real Tauri `open_external` command and its OS handoff — and that the
//! backstop is *not* the thing that handled it.
//!
//! **Why it is `#[ignore]`d.** `cargo test` is the everyday loop (and CI's
//! first gate); it must not open windows, spawn a driver, or depend on a
//! WebView2 runtime. This test is run explicitly — `cargo test --test
//! navigation_webview -- --ignored` — by the WebView job in `.github/workflows/ci.yml`.
//! It never skips silently: a missing binary, driver or native driver fails
//! with a message naming the thing to install.
//!
//! Run it locally with one command:
//!
//! ```text
//! npm run e2e:navigation
//! ```
//!
//! `scripts/verify-navigation-webview.mjs` resolves a native driver that matches
//! the installed WebView2 runtime (downloading that msedgedriver when none is on
//! `PATH`), serves the dev origin, builds the app, runs the test and stops the
//! server it started. `--no-build`, `--keep-server`, `--driver`, `--app` and
//! `--port` are the knobs. The same steps by hand, which is worth knowing when
//! something in the chain misbehaves:
//!
//! ```text
//! npm run dev -w @netpulse/web -- --host 127.0.0.1   # the window loads this, see below
//! cargo build --manifest-path src-tauri/Cargo.toml
//! set NAV_WEBVIEW_APP=src-tauri\target\debug\netpulse-desktop.exe
//! set MSEDGEDRIVER=C:\path\to\msedgedriver.exe
//! cargo test --manifest-path src-tauri/Cargo.toml --test navigation_webview -- --ignored --nocapture
//! ```
//!
//! **The dev server is not optional for a debug build.** Tauri sets its `dev`
//! cfg for one, so the window resolves to `build.devUrl` — `frontendDist` is not
//! what it loads — and with nothing listening on that origin the window shows
//! `chrome-error://chromewebdata/` while `GET /url` still answers with the
//! requested URL. A `--release` build has the bundle compiled in and needs no
//! server. Measured both ways. If the window stays on the error page, check which
//! loopback address the server actually bound (`vite --host 127.0.0.1` when it
//! took only the IPv6 loopback and the webview resolved the other one).
//!
//! `MSEDGEDRIVER` is optional: without it `tauri-driver` looks for the driver on
//! `PATH` (which is how the CI job installs it).
//!
//! **The handoff evidence is data, not log text.** Where the window ends up is
//! only half the rule: the backstop must refuse the navigation *and* hand the URL
//! to the OS, and a `classify` that refused everything would leave the window in
//! exactly the same place as a correct one. The OS browser is a separate process
//! this test cannot drive, so every handoff is observed through the record the
//! app appends to the file named by `NETPULSE_HANDOFF_RECORD` — one JSON object
//! per handoff, carrying the URL, the layer that opened it
//! (`command` / `navigation` / `new-window`) and whether the spawn succeeded.
//! This test points that variable at a temp file and reads the rows as data.
//!
//! It used to match log phrases instead, which made every message wording part of
//! a contract: renaming `opening external link for host …` broke the test, and
//! telling the two layers apart required asserting the ABSENCE of the other
//! layer's line, because both converge on one launch path. The record carries
//! that distinction as a field, so a reworded message cannot fail anything here.
//!
//! The variable is unset in every normal run — a durable journal of the URLs the
//! app opened is a browsing record this product does not keep — and the test
//! deletes the file when the run passes.

use std::fs::File;
use std::io::Read;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::Method;
use serde_json::{json, Value};

/// How long the intermediary may take to start and reach its native driver.
const DRIVER_READY: Duration = Duration::from_secs(30);
/// A cold app on CI starts a sidecar and a webview; the window's first document
/// arrived in under a second locally, but the session itself can wait on the
/// backend's bootstrap.
const APP_DOCUMENT: Duration = Duration::from_secs(120);
/// How long a refused navigation is given to (not) happen. WebView2 reports the
/// blocked URL back to the caller almost immediately; this is generous because
/// it runs on a CI machine that is also compiling.
const SETTLE: Duration = Duration::from_millis(1_500);
/// How long a handoff row is given to appear. The app writes it on the same
/// thread that decides, so this is only waiting for the append to be visible.
const RECORD_ROW: Duration = Duration::from_secs(20);

/// The environment variable naming the handoff record file. Mirrors the constant
/// in `src-tauri/src/os_open.rs`, which the app reads; an integration test cannot
/// see the crate's private items, so the name is repeated here.
const HANDOFF_RECORD_ENV: &str = "NETPULSE_HANDOFF_RECORD";

/// One row of that record. `source` is the layer that opened the URL: `command`
/// (the page's guard → the `open_external` command), `navigation` (the
/// `on_navigation` backstop) or `new-window` (the `on_new_window` backstop).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Handoff {
    url: String,
    source: String,
    ok: bool,
}

fn app_binary() -> PathBuf {
    if let Ok(path) = std::env::var("NAV_WEBVIEW_APP") {
        return PathBuf::from(path);
    }
    let name = if cfg!(windows) { "netpulse-desktop.exe" } else { "netpulse-desktop" };
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("debug").join(name)
}

fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind a loopback port");
    listener.local_addr().expect("local addr").port()
}

/// The driver process and the log it forwards the app's output into.
///
/// Dropping it kills the child, so a failed assertion cannot leave a WebDriver
/// and an app window behind for the next run (or for the user).
struct Driver {
    child: Child,
    base: String,
    log_path: PathBuf,
    /// Where the app appends one JSON object per handoff (see the module docs).
    record_path: PathBuf,
}

impl Driver {
    fn start() -> Self {
        let bin = std::env::var("TAURI_DRIVER").unwrap_or_else(|_| "tauri-driver".to_string());
        let port = free_port();
        let native_port = free_port();
        let log_path = std::env::temp_dir().join(format!("netpulse-webdriver-{}.log", std::process::id()));
        // A fresh record per run: it is the handoff evidence, so it has to be
        // empty before the app starts or every count below means nothing.
        let record_path = std::env::temp_dir().join(format!("netpulse-handoffs-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&record_path);

        let mut cmd = Command::new(&bin);
        cmd.arg("--port")
            .arg(port.to_string())
            .arg("--native-port")
            .arg(native_port.to_string())
            .stdin(Stdio::null())
            // The app is launched by the native driver, which tauri-driver
            // starts as its child, so the variable reaches the app through this
            // process's environment. If it ever stops doing so, the handoff
            // waits below fail with the record path in the message.
            .env(HANDOFF_RECORD_ENV, &record_path);
        if let Ok(native) = std::env::var("MSEDGEDRIVER") {
            cmd.arg("--native-driver").arg(native);
        }

        // The driver forwards the app's own stderr into its own, so this file is
        // the app's log for the duration of the run — the first place to look
        // when the window never reaches the app document.
        let log = File::create(&log_path).unwrap_or_else(|e| panic!("create {}: {e}", log_path.display()));
        let log_err = log.try_clone().expect("clone the driver log handle");
        cmd.stdout(Stdio::from(log)).stderr(Stdio::from(log_err));

        let child = cmd.spawn().unwrap_or_else(|e| {
            panic!(
                "could not start `{bin}`: {e}\n\
                 install it with `cargo install tauri-driver --locked` or point TAURI_DRIVER at it"
            )
        });
        Self { child, base: format!("http://127.0.0.1:{port}"), log_path, record_path }
    }

    /// Poll the intermediary until it reports its native driver ready.
    ///
    /// The client passed in must not use a proxy: see the note in the test.
    fn wait_ready(&self, client: &Client) {
        let deadline = Instant::now() + DRIVER_READY;
        loop {
            if let Ok(res) = client.get(format!("{}/status", self.base)).send() {
                if let Ok(json) = res.json::<Value>() {
                    if json["value"]["ready"].as_bool() == Some(true) {
                        return;
                    }
                }
            }
            if Instant::now() >= deadline {
                panic!(
                    "tauri-driver did not become ready at {}\n{}",
                    self.base,
                    self.log_tail()
                );
            }
            sleep(Duration::from_millis(200));
        }
    }

    /// Every handoff the app has recorded so far, parsed as data.
    ///
    /// A line is only returned once it parses. The app appends whole lines, but
    /// a reader can still catch a partially flushed tail, and half a row must
    /// not fail an assertion for the wrong reason.
    fn handoffs(&self) -> Vec<Handoff> {
        std::fs::read_to_string(&self.record_path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|row| {
                Some(Handoff {
                    url: row["url"].as_str()?.to_string(),
                    source: row["source"].as_str()?.to_string(),
                    ok: row["ok"].as_bool()?,
                })
            })
            .collect()
    }

    /// The record's raw content, for a failure message. An unreadable file is
    /// itself the answer when a handoff never arrives (the variable did not
    /// reach the app, or nothing was recorded).
    fn record_summary(&self) -> String {
        match std::fs::read_to_string(&self.record_path) {
            Ok(text) => format!("--- {} ---\n{}", self.record_path.display(), text.trim_end()),
            Err(e) => format!("--- {} --- (unreadable: {e})", self.record_path.display()),
        }
    }

    /// The last few kilobytes of the driver/app log, for a failure message.
    fn log_tail(&self) -> String {
        let mut text = String::new();
        if let Ok(mut file) = File::open(&self.log_path) {
            let _ = file.read_to_string(&mut text);
        }
        let start = text.len().saturating_sub(4_000);
        format!("--- {} ---\n{}", self.log_path.display(), &text[start..])
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // A passing run has no reason to keep its driver log; a failing one is
        // the only copy of what the app said, so keep it and point at it.
        if std::thread::panicking() {
            eprintln!("{}", self.log_tail());
            eprintln!("{}", self.record_summary());
        } else {
            let _ = std::fs::remove_file(&self.log_path);
            let _ = std::fs::remove_file(&self.record_path);
        }
    }
}

/// Deletes the WebDriver session however the test ends.
struct Session {
    base: String,
    id: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        // `no_proxy` here too: deleting the session is a loopback call, and a
        // system proxy that cannot reach 127.0.0.1 must not be consulted (see
        // the client in the test for why this product makes that likely).
        let client = Client::builder().no_proxy().build().expect("http client");
        let _ = client
            .request(Method::DELETE, format!("{}/session/{}", self.base, self.id))
            .send();
    }
}

/// One WebDriver request, with the `value` unwrapped and errors made readable.
fn call(client: &Client, method: Method, url: &str, body: Option<Value>) -> Value {
    let mut request = client.request(method.clone(), url);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().unwrap_or_else(|e| panic!("{method} {url}: {e}"));
    let status = response.status();
    let json: Value = response.json().unwrap_or(Value::Null);
    if !status.is_success() {
        let message = json["value"]["message"].as_str().unwrap_or("(no message)");
        panic!("{method} {url} failed ({status}): {message}");
    }
    json["value"].clone()
}

fn execute(client: &Client, session: &Session, script: &str) -> Value {
    call(
        client,
        Method::POST,
        &format!("{}/session/{}/execute/sync", session.base, session.id),
        Some(json!({ "script": script, "args": [] })),
    )
}

/// Find one element through WebDriver's own element lookup (the id is the
/// engine's element handle, not the DOM id).
fn find_element(client: &Client, session: &Session, selector: &str) -> String {
    let found = call(
        client,
        Method::POST,
        &format!("{}/session/{}/element", session.base, session.id),
        Some(json!({ "using": "css selector", "value": selector })),
    );
    found["element-6066-11e4-a52e-4f735466cecf"]
        .as_str()
        .unwrap_or_else(|| panic!("no element matched {selector}: {found}"))
        .to_string()
}

/// Click an element the way a user does — WebDriver's own input pipeline, not a
/// script-dispatched `click()`, which is untrusted and would bypass the engine's
/// real event path.
fn click_element(client: &Client, session: &Session, element: &str) {
    // An empty object, not no body: WebDriver reads the command parameters from
    // the JSON body and answers "missing command parameters" without one.
    call(
        client,
        Method::POST,
        &format!("{}/session/{}/element/{}/click", session.base, session.id, element),
        Some(json!({})),
    );
}

fn current_url(client: &Client, session: &Session) -> String {
    call(client, Method::GET, &format!("{}/session/{}/url", session.base, session.id), None)
        .as_str()
        .unwrap_or_default()
        .to_string()
}

/// The document the window is really showing, as the page reports it.
///
/// This is a different question from `current_url`, which answers with the URL
/// that was *requested*: a load that never reached a server still reads there as
/// the app while the window is showing the engine's error page
/// (`chrome-error://chromewebdata/`). Measured, not theorised: with no dev server
/// running, every URL-based assertion below passed against an error page.
fn document_href(client: &Client, session: &Session) -> String {
    execute(client, session, "return document.location.href;")
        .as_str()
        .unwrap_or_default()
        .to_string()
}

/// The app's own document. A release-shaped build embeds the assets and serves
/// them from Tauri's custom protocol; a `tauri dev` build loads the Vite
/// server instead. Which one is in use is a build detail — both are the app.
fn is_app_document(url: &str) -> bool {
    url.contains("tauri.localhost") || url.contains("localhost:5173") || url.contains("127.0.0.1:5173")
}

/// Does the page report the in-page guard as installed?
///
/// The guard stores its disposer on the document under
/// `Symbol.for('netpulse.external-navigation-guard')`, so this asks the guard's
/// own registry (see `apps/web/src/lib/externalNavigation.ts`) rather than
/// guessing from the DOM.
fn guard_installed(client: &Client, session: &Session) -> bool {
    execute(
        client,
        session,
        "return typeof document[Symbol.for('netpulse.external-navigation-guard')] === 'function';",
    )
    .as_bool()
    .unwrap_or(false)
}

/// Wait until the record holds a successful handoff of `url` by `source`, then
/// return the total number of rows.
///
/// Every handoff assertion goes through this rather than a fixed sleep: the
/// record is the assertion's subject, so "not there yet" has to be a wait and not
/// a flaky failure on a loaded CI machine.
fn wait_for_handoff(driver: &Driver, url: &str, source: &str) -> usize {
    wait_for(
        &format!("a `{source}` handoff of {url} to be recorded"),
        RECORD_ROW,
        || {
            let rows = driver.handoffs();
            rows.iter()
                .any(|row| row.url == url && row.source == source && row.ok)
                .then_some(rows.len())
        },
        || driver.record_summary(),
    )
}

fn wait_for<T>(what: &str, timeout: Duration, mut poll: impl FnMut() -> Option<T>, log: impl Fn() -> String) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = poll() {
            return value;
        }
        if Instant::now() >= deadline {
            panic!("timed out waiting for {what}\n{}", log());
        }
        sleep(Duration::from_millis(150));
    }
}

#[test]
#[ignore = "launches a real webview through tauri-driver; run with -- --ignored"]
fn the_navigation_backstop_holds_in_a_real_webview() {
    let app = app_binary();
    assert!(
        app.is_file(),
        "app binary not found at {}\nbuild it first (`cargo build --manifest-path src-tauri/Cargo.toml`) or set NAV_WEBVIEW_APP",
        app.display()
    );

    let driver = Driver::start();
    // `no_proxy` is not an optimisation here: this product installs a system
    // proxy for the tunnel, and reqwest honours the OS proxy settings. Routing
    // a WebDriver call to 127.0.0.1 through the tunnel's proxy fails (the proxy
    // is not a WebDriver server), which looked exactly like "the driver never
    // became ready". A loopback endpoint is never proxied.
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("http client");

    driver.wait_ready(&client);

    // `tauri:options.application` is what tauri-driver turns into the native
    // driver's binary; it launches the app itself.
    let created = call(
        &client,
        Method::POST,
        &format!("{}/session", driver.base),
        Some(json!({
            "capabilities": { "alwaysMatch": { "tauri:options": { "application": app } } }
        })),
    );
    let id = created["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("no sessionId in {created}\n{}", driver.log_tail()))
        .to_string();
    let session = Session { base: driver.base.clone(), id };
    let tail = || driver.log_tail();

    // The window starts on `about:blank` and only then asks for the app document.
    //
    // Both halves are required before anything else is asserted: the requested
    // URL must be the app AND the document in the window must be the app, so a
    // build whose assets or dev server are missing fails here honestly instead of
    // passing a URL-shaped check against an error page.
    let initial = wait_for(
        "the app document to load",
        APP_DOCUMENT,
        || {
            let url = current_url(&client, &session);
            if !is_app_document(&url) {
                return None;
            }
            is_app_document(&document_href(&client, &session)).then_some(url)
        },
        tail,
    );

    // ---- 1. engine-initiated navigation is refused --------------------------
    //
    // Not an anchor click: a click is handled in JS before the engine sees it,
    // so it would test the in-page guard rather than the callback. Assigning
    // `location.href` is the backstop's job.
    let handoffs_before = driver.handoffs().len();
    execute(&client, &session, "location.href = 'https://example.com/'; return true;");
    sleep(SETTLE);
    let after_navigation = current_url(&client, &session);
    assert_eq!(
        after_navigation, initial,
        "the webview followed an engine-initiated external navigation; the on_navigation backstop did not refuse it"
    );
    // The document itself must still be the app, not an error page the engine
    // swapped in after the URL check.
    let href = document_href(&client, &session);
    assert!(
        is_app_document(&href),
        "the document is no longer the app after the blocked navigation: {href}"
    );

    // ---- 1b. …and the OS was asked to open it ------------------------------
    //
    // Refusing *and silently dropping* would satisfy everything above, so prove
    // the other half of the rule. The row names the URL, the layer that opened it
    // and whether the spawn succeeded — no message wording is part of this.
    let rows_after_navigation = wait_for_handoff(&driver, "https://example.com/", "navigation");
    assert_eq!(
        rows_after_navigation,
        handoffs_before + 1,
        "a blocked external navigation must be handed to the OS exactly once, as a `navigation` handoff: {}",
        driver.record_summary()
    );

    // ---- 2. a new window is denied, and does not become one ----------------
    let handoffs_before_open = driver.handoffs().len();
    execute(&client, &session, "window.open('https://example.com/','_blank'); return true;");
    sleep(SETTLE);
    let handles = call(
        &client,
        Method::GET,
        &format!("{}/session/{}/window/handles", session.base, session.id),
        None,
    );
    let count = handles.as_array().map(Vec::len).unwrap_or(0);
    assert_eq!(
        count, 1,
        "window.open created a second webview; on_new_window must answer Deny (handles: {handles})"
    );
    assert_eq!(
        current_url(&client, &session),
        initial,
        "the original window navigated because of a window.open request"
    );

    // ---- 2b. …and that URL reached the OS too ------------------------------
    //
    // A denied new window that also dropped the URL would leave the user with a
    // link that does nothing, which is why `on_new_window` hands it off rather
    // than only refusing. The row's `source` also pins WHICH layer did it, and
    // the exact count makes a double launch fail as well.
    let rows_after_open = wait_for_handoff(&driver, "https://example.com/", "new-window");
    assert_eq!(
        rows_after_open,
        handoffs_before_open + 1,
        "a denied new window must be handed to the OS exactly once, as a `new-window` handoff: {}",
        driver.record_summary()
    );

    // ---- 3. an in-page anchor click is handed off by the JS guard ----------
    //
    // The other exit that hands a link to the OS — and the one no engine
    // callback can see. `externalNavigation.ts` listens on the document in the
    // capture phase, so a left click on a raw anchor is `preventDefault()`ed and
    // routed through the `open_external` command before the engine ever has a
    // navigation to classify. The anchor is injected here rather than rendered
    // by a component: that is exactly the "raw anchor a component forgot" case
    // the guard exists for. It is activated through WebDriver's element-click
    // endpoint, i.e. a real engine input event.
    let handoffs_before_click = driver.handoffs().len();

    // Only click once the guard is running. The app document reloads after a
    // refused navigation, and a click during that reload goes straight to the
    // engine: measured once, before this wait existed, as a `navigation` row for
    // this step. Waiting here turns that race into an explicit check — the guard
    // itself says whether it is installed — instead of a misattributed handoff.
    wait_for(
        "the in-page external-navigation guard to report itself installed",
        Duration::from_secs(20),
        || guard_installed(&client, &session).then_some(()),
        || {
            format!(
                "document href: {}\n{}",
                document_href(&client, &session),
                driver.record_summary()
            )
        },
    );

    execute(
        &client,
        &session,
        "const a = document.createElement('a');\
         a.id = 'np-external-probe';\
         a.setAttribute('href', 'https://example.com/');\
         a.textContent = 'external';\
         a.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;width:120px;height:24px;display:block;';\
         document.body.appendChild(a);\
         return true;",
    );
    let probe = find_element(&client, &session, "#np-external-probe");
    click_element(&client, &session, &probe);

    // The OS must be asked, exactly once — and by the guard, not by the engine.
    // `source: command` is that distinction as a field: a click that fell through
    // to `on_navigation` would be recorded as `navigation`, and one WebDriver
    // turned into a new-window request as `new-window`. Before the record existed
    // this was inferred from the ABSENCE of the backstop's log lines.
    let rows_after_click = wait_for_handoff(&driver, "https://example.com/", "command");
    assert_eq!(
        rows_after_click,
        handoffs_before_click + 1,
        "an external anchor click must be handed to the OS exactly once, as a `command` handoff (twice would mean the guard opened it and the backstop did too): {}",
        driver.record_summary()
    );
    assert_eq!(
        current_url(&client, &session),
        initial,
        "an external anchor click navigated the window away from the app"
    );
    let clicked_href = document_href(&client, &session);
    assert!(
        is_app_document(&clicked_href),
        "the document is no longer the app after the anchor click: {clicked_href}"
    );
    execute(&client, &session, "document.getElementById('np-external-probe')?.remove(); return true;");

    // ---- 4. a URL the validator refuses launches nothing -------------------
    //
    // The distinction the backstop exists to make: https is handed off,
    // everything else is dropped. Without this, a `classify` that answered
    // `External` unconditionally — handing the OS a `javascript:` URL — would
    // pass every assertion above.
    let handoffs_before_refusal = driver.handoffs().len();
    execute(&client, &session, "location.href = 'http://example.com/'; return true;");
    sleep(SETTLE);
    // The window staying put IS the refusal: a plain http navigation is one the
    // engine would otherwise follow. There is nothing to wait for in the record,
    // because a refusal is the ABSENCE of a row — so the window is given the same
    // settle time the blocked navigations got, and the record is then read.
    assert_eq!(
        current_url(&client, &session),
        initial,
        "plaintext http was followed; the backstop must refuse it"
    );
    assert!(
        is_app_document(&document_href(&client, &session)),
        "the document is no longer the app after the refused http navigation"
    );
    assert_eq!(
        driver.handoffs().len(),
        handoffs_before_refusal,
        "a refused URL must not be handed to the OS: {}",
        driver.record_summary()
    );

    // ---- 5. the app's own routing still works ------------------------------
    //
    // A backstop that refuses everything would pass the two assertions above
    // and break every link in the product, so prove the allow-list is live.
    execute(&client, &session, "location.hash = '#/vpn'; return true;");
    wait_for(
        "the in-app route change to apply",
        Duration::from_secs(10),
        || {
            let url = current_url(&client, &session);
            url.contains("#/vpn").then_some(())
        },
        tail,
    );
}
