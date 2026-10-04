//! The system tray icon and its two actions.
//!
//! Owned separately from supervision: building a menu is a UI concern, and
//! the quit path here has ordering requirements (destroy the window BEFORE
//! `app.exit`) that have nothing to do with stopping the sidecar.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open NetPulse", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("NetPulse")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                // Destroy windows BEFORE app.exit: with close-to-tray the main
                // window is hidden rather than closed, and quitting through
                // tao's destroy-during-teardown path has crashed with
                // "cannot move state from Destroyed" (fatal under panic=abort).
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.destroy();
                }
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
