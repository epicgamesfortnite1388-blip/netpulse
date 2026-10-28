//! The navigation backstop, enforced outside the webview.
//!
//! `apps/web/src/lib/externalNavigation.ts` already intercepts every anchor
//! activation and every dropped link in the page, and `openExternalUrl` hands a
//! link to the OS. That guard lives *inside* the document, though: it is
//! JavaScript that the page must have loaded and that the engine must route an
//! event through. It cannot see a navigation the webview starts by itself —
//! `location.href` in injected code, a redirect, a restored session, a
//! `window.open` from a popup that never went through the DOM — and it is
//! simply absent while the bundle is still loading, after a failed load, or in
//! any future page that forgets to install it.
//!
//! So the same rule is enforced twice, in two different languages:
//!
//!   | exit                      | first line of defence            | backstop here |
//!   |---------------------------|----------------------------------|---------------|
//!   | anchor click / link drop  | `externalNavigation.ts`          | yes           |
//!   | `window.open`, `_blank`   | —                                | yes           |
//!   | engine-initiated navigate | —                                | yes           |
//!
//! The decision is a pure function (`classify`) so the policy is unit-tested
//! directly, without a window: `window.rs` only wires it to the two callbacks.
//!
//! **What the rule is.** A navigation may stay inside the window only when it
//! targets the app's own document — the bundled-asset origin
//! (`http(s)://tauri.localhost`, or `tauri://localhost` on macOS/Linux) or, in
//! a debug build, the dev server it was started from. An `https` URL is handed
//! to the OS browser through the same validator `open_external` uses, so the
//! backstop can never launch something the command would refuse. Everything
//! else — `http:`, `javascript:`, `file:`, `mailto:`, custom schemes, a URL
//! carrying credentials — is refused outright and nothing is launched.
//!
//! A new window is *never* created: Tauri would render it as a second in-app
//! webview with no browser chrome and no protocol handler for the destination,
//! which is exactly the dead end the JS guard exists to avoid. The URL is
//! handed to the OS instead, when it is one the validator accepts.

use tauri::Url;

/// What to do with a URL the webview is trying to leave for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Navigation {
    /// The app's own document: load it in the window.
    InApp,
    /// Leave the app: hand this (already validated) URL to the OS browser.
    External(Url),
    /// Refuse, and open nothing.
    Refused,
}

/// Decide what a navigation or a new-window request may do.
///
/// `dev_origin` is the dev server the window was loaded from, when this is a
/// debug build; `None` in a release build, where the bundled assets are the
/// only app document.
pub(crate) fn classify(url: &Url, dev_origin: Option<&Url>) -> Navigation {
    if is_app_document(url, dev_origin) {
        return Navigation::InApp;
    }
    // Reuse the command's validator rather than restating its rules: a URL the
    // backstop opens is exactly a URL `open_external` would have accepted.
    match crate::os_open::validated_external_url(url.as_str()) {
        Ok(parsed) => Navigation::External(parsed),
        Err(_) => Navigation::Refused,
    }
}

/// Is this the app's own document?
///
/// Host comparison is equality, never a suffix: `tauri.localhost.evil.com` is a
/// different host and is treated as external.
fn is_app_document(url: &Url, dev_origin: Option<&Url>) -> bool {
    // The engine's own empty document. Refusing it would break the blank page
    // a webview starts from; it carries no origin and no content.
    if url.as_str() == "about:blank" {
        return true;
    }
    match (url.scheme(), url.host_str()) {
        // macOS and Linux serve the bundled assets over the custom protocol.
        ("tauri", Some("localhost")) => true,
        // Windows exposes the same assets as a loopback-looking HTTP origin.
        // Both schemes are accepted: which one is used is a build setting, and
        // refusing the other would break the app's own reload.
        //
        // These are Tauri's own values, not guesses: `Manager::tauri_protocol_url`
        // resolves the bundled document to `tauri://localhost` or its wry
        // workaround `http(s)://tauri.localhost`. Tauri's private `is_local_url`
        // answers the same question, but it takes a `Webview` and is not
        // reachable from a builder callback — hence the explicit list here,
        // with the `on_page_load` log line in `window.rs` reporting which one
        // this build actually resolved to.
        ("http" | "https", Some("tauri.localhost")) => true,
        _ => dev_origin.is_some_and(|dev| same_origin(url, dev)),
    }
}

/// Scheme, host and port all equal (the definition of an origin).
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
pub(crate) mod tests;
