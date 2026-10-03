//! Main-window presentation: restore, size to the monitor, centre, focus.
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
//! This module owns *only* presentation. It decides where the window goes and
//! how big it is; it never decides what the app does.

use crate::sidecar::{log_error, log_info, log_warn};
use tauri::{AppHandle, Manager};

/// Never smaller than this: 240px sidebar + an `lg`-width content column.
const MIN_W: u32 = 1120;
const MIN_H: u32 = 680;
/// Enough of the screen to read comfortably without maximising, while still
/// leaving the desktop visible around the window.
const FRACTION: f64 = 0.86;

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
