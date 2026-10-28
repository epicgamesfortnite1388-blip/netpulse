//! The main window: created here, then restored, sized, centred and focused.
//!
//! Split out of `main.rs` because this is the one part of startup that is
//! Windows-specific *and* stateful in a way the rest of the file is not. It
//! needs the display's physical metrics converted through the DPI scale
//! factor, and it re-asserts itself on a timer because Windows minimises the
//! window a second after it first appears. None of that is related to
//! bootstrap, safe mode, data paths, runtime status or the IPC commands that
//! share `main.rs`, and keeping it there meant reading 700 lines to answer
//! "why is the window the wrong size?".
//!
//! **The window is built in Rust, not in `tauri.conf.json`.** A config-declared
//! window cannot carry `on_navigation` / `on_new_window` — those are builder
//! callbacks — and without them the webview's navigation policy exists only in
//! JavaScript, i.e. only for as long as a page that installs it is running.
//! Creating the window here is what puts the backstop in front of the first
//! navigation, before any bundle has loaded. `tauri.conf.json` therefore has no
//! `app.windows` entry, and the label here (`main`) is the one capabilities,
//! the tray and the single-instance plugin look up.
//!
//! This module owns presentation and the window's creation; the policy itself
//! lives in `navigation.rs`.

use crate::logging::{log_error, log_info, log_warn};
use crate::navigation::{classify, Navigation};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Never smaller than this: 240px sidebar + an `lg`-width content column.
const MIN_W: u32 = 1120;
const MIN_H: u32 = 680;
/// Enough of the screen to read comfortably without maximising, while still
/// leaving the desktop visible around the window.
const FRACTION: f64 = 0.86;

/// Build the main window and install the navigation backstop.
///
/// Both callbacks are registered on the builder, so they exist before the first
/// byte of the page is parsed. Everything the app legitimately loads is the
/// bundled-asset document (or, in a debug build, the dev server); anything else
/// is either handed to the OS browser or refused — see `navigation::classify`.
///
/// A second webview is never created: `on_new_window` always answers `Deny`,
/// because Tauri would render it without browser chrome and without a protocol
/// handler for the destination (`t.me` included) — a blank in-app window the
/// user cannot get out of.
///
/// The dev origin is read from the same config `tauri dev` uses, and only in a
/// debug build. A release build has no dev server, so it has no such origin to
/// allow.
///
/// The log lines in both callbacks are diagnostics for a human reading the log.
/// What `tests/navigation_webview.rs` asserts through a real WebDriver session is
/// the *data* `os_open` records per handoff — URL, source and spawn outcome (see
/// `HandoffSource` / `record_handoff`) — so rewording a message cannot break that
/// test. The record exists because the alternative evidence for a handoff is a
/// browser window nobody can drive.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let dev_origin = if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let nav_dev = dev_origin.clone();
    let window_dev = dev_origin;

    // The label `main` is what capabilities, the tray and the single-instance
    // plugin look up; it used to be declared alongside these options in
    // `tauri.conf.json`.
    let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("NetPulse")
        // A first-paint size the presentation pass corrects to the monitor;
        // 1280x800 is only what the window exists at for that first frame.
        .inner_size(1280.0, 800.0)
        .min_inner_size(980.0, 620.0)
        .center()
        .visible(true)
        .focused(true)
        // Matches `backgroundColor` in the old config: no white flash between
        // the window appearing and the first frame of the dark UI.
        .background_color(tauri::window::Color(0x0b, 0x0f, 0x17, 0xff))
        .on_navigation(move |url| match classify(url, nav_dev.as_ref()) {
            Navigation::InApp => true,
            Navigation::External(target) => {
                log_info!(
                    "navigation backstop: handing {} to the OS browser",
                    target.host_str().unwrap_or("")
                );
                if let Err(e) = crate::os_open::open_external_url(
                    &target,
                    crate::os_open::HandoffSource::Navigation,
                ) {
                    log_warn!("navigation backstop: could not open the URL: {e}");
                }
                false
            }
            Navigation::Refused => {
                log_warn!(
                    "navigation backstop: refused {}://{} (the app never loads it and never opens it)",
                    url.scheme(),
                    url.host_str().unwrap_or("")
                );
                false
            }
        })
        // The creation-time URL is `about:blank`: WebView2 starts an empty
        // document and only then asks for the app. Logging each finished load
        // is what makes "which document is actually in the window" answerable
        // from the log instead of by looking at the screen.
        .on_page_load(|_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                log_info!("main window loaded {}", payload.url());
            }
        })
        .on_new_window(move |url, _features| {
            // Every new window is refused, including an in-app URL: the app is
            // one document. An external https link still reaches the browser.
            match classify(&url, window_dev.as_ref()) {
                Navigation::External(target) => {
                    log_info!(
                        "new-window backstop: opening {} externally instead",
                        target.host_str().unwrap_or("")
                    );
                    if let Err(e) = crate::os_open::open_external_url(
                        &target,
                        crate::os_open::HandoffSource::NewWindow,
                    ) {
                        log_warn!("new-window backstop: could not open the URL: {e}");
                    }
                }
                Navigation::InApp => log_warn!("new-window backstop: refused an in-app window"),
                Navigation::Refused => log_warn!(
                    "new-window backstop: refused {}://{}",
                    url.scheme(),
                    url.host_str().unwrap_or("")
                ),
            }
            NewWindowResponse::Deny
        })
        .build()?;

    // At this point the webview holds `about:blank`; the app document is
    // requested after creation and reported by `on_page_load` above. The
    // allow-list in `navigation.rs` is written from the documented origins, so
    // that load line is also how a future Tauri release choosing a different
    // origin would show up — instead of as a window that refuses to reload.
    log_info!("main window created in Rust");
    Ok(win)
}

/// Show, size and focus the main window once the app is actually running.
///
/// This has to wait for `RunEvent::Ready` rather than run in `setup`. The
/// window arrives *minimized*: measured on Windows, `IsIconic` was true from
/// the first moment the process had a window, and forcing `SW_RESTORE` turned a
/// 160x28 window parked at (-32000,-32000) into a real one. Calling
/// `unminimize()` from `setup` did not stick, because Windows has not finished
/// creating and showing the window at that point and minimises it again
/// afterwards — so the restore has to happen once the event loop is up and the
/// window is final.
///
/// Restoring here also means this is the single place that decides how big the
/// window is, instead of a hardcoded size in tauri.conf.json that is wrong on
/// every display except the one it was written on.
pub fn present_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        log_error!("main window handle missing at RunEvent::Ready");
        return;
    };
    let _ = win.show();
    let _ = win.unminimize();
    fit_window_to_monitor(&win);
    let _ = win.set_focus();
    log_info!("main window shown, sized and centered");

    // Something in the Windows startup sequence minimizes this window about a
    // second after it appears — measured, not assumed: the window is correct
    // and `is_minimized() == false` when this function runs, and a few seconds
    // later Windows has moved it to (-32000, -32000) and reported a 0x0 client
    // area, with no window event from the app and no `minimize()` call anywhere
    // in this codebase or the webview. Forcing `SW_RESTORE` from outside the
    // process fixes it and it then stays put, so it is a one-shot startup
    // event rather than something recurring.
    //
    // Re-asserting once the startup sequence has finished is the fix. It is
    // deliberately bounded and conditional: it only acts while the window is
    // still in its first few seconds and only when it is actually minimized,
    // so it can never yank the window back from someone who minimized it
    // deliberately later on.
    let handle = app.clone();
    std::thread::spawn(move || {
        for (i, delay_secs) in [3u64, 8].into_iter().enumerate() {
            std::thread::sleep(std::time::Duration::from_secs(if i == 0 { delay_secs } else { delay_secs - 3 }));
            let Some(w) = handle.get_webview_window("main") else { return };
            match w.is_minimized() {
                Ok(true) => {
                    log_warn!("window was minimized during startup (check {i}); restoring it");
                    let _ = w.unminimize();
                    fit_window_to_monitor(&w);
                    let _ = w.set_focus();
                    log_info!("window restored after startup minimization");
                }
                Ok(false) => {}
                Err(e) => log_warn!("could not read the window's minimized state: {e}"),
            }
        }
    });
}

/// Size the window to the monitor it opens on, then centre it.
///
/// The window used to open at a hardcoded 1280x800, which is wrong in both
/// directions: on a 2560x1440 display that leaves most of the screen empty and
/// forces the user to maximise the window before the app is usable, while on a
/// 1366x768 laptop a 1280-wide window is wider than the screen and pushes the
/// right-hand column off it entirely. Both are the same bug — a fixed pixel
/// size that has no relationship to the display.
///
/// What is sized here is the *work area* rather than the full screen, so the
/// taskbar and any docked window strip are excluded; the result is also capped
/// to the work area so the window can never end up partly off-screen.
///
/// The floor matters as much as the ceiling (see `MIN_W`/`MIN_H`).
///
/// Physical monitor metrics are converted to logical units by the scale factor,
/// because `set_size` takes logical pixels: on a 150% display a 1920x1080
/// work area is 1280x720 logical, and asking for 1920 would produce a window
/// 1.5x too large and overflow the screen it was measured against.
fn fit_window_to_monitor(win: &tauri::WebviewWindow) {
    // Measure the display in logical pixels. A monitor we cannot query must not
    // leave the window unusable, so this falls back to merely centring whatever
    // size the config asked for.
    let (want_w, want_h, avail_w, avail_h) = match win.current_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor().max(0.1);
            let area = monitor.work_area();
            let avail_w = ((area.size.width as f64) / scale).round() as u32;
            let avail_h = ((area.size.height as f64) / scale).round() as u32;
            if avail_w == 0 || avail_h == 0 {
                log_warn!("monitor reported a zero-sized work area; centring the default window size");
                let _ = win.center();
                return;
            }
            // Take a share of the screen, never exceeding what it actually
            // offers and never dropping below the floor where the layout works.
            let want_w = ((avail_w as f64 * FRACTION).round() as u32)
                .min(avail_w)
                .max(MIN_W.min(avail_w));
            let want_h = ((avail_h as f64 * FRACTION).round() as u32)
                .min(avail_h)
                .max(MIN_H.min(avail_h));
            (want_w, want_h, avail_w, avail_h)
        }
        _ => {
            log_warn!("could not query the monitor; centring the default window size");
            let _ = win.center();
            return;
        }
    };

    let _ = win.set_size(tauri::LogicalSize::new(want_w, want_h));

    // set_size sizes the *outer* frame, so the content area comes out smaller
    // by the title bar and borders. Measure that shortfall and add it back,
    // rather than guessing a border thickness that differs per platform and
    // per Windows theme.
    if let (Ok(inner), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
        if scale > 0.0 {
            let got_w = ((inner.width as f64) / scale).round() as i64;
            let got_h = ((inner.height as f64) / scale).round() as i64;
            let adj_w = (want_w as i64 + (want_w as i64 - got_w)).clamp(1, i64::from(avail_w)) as u32;
            let adj_h = (want_h as i64 + (want_h as i64 - got_h)).clamp(1, i64::from(avail_h)) as u32;
            if adj_w != want_w || adj_h != want_h {
                let _ = win.set_size(tauri::LogicalSize::new(adj_w, adj_h));
                log_info!("main window content area {want_w}x{want_h} logical (frame {adj_w}x{adj_h})");
            }
            log_info!("main window sized to {want_w}x{want_h} logical (monitor offers {avail_w}x{avail_h})");
        }
    } else {
        log_info!("main window sized to {want_w}x{want_h} logical");
    }
    let _ = win.center();
}
