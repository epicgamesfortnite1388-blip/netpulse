# Webview external navigation — audit and closure

**Date:** 2026-10-24
**Scope:** every way the packaged Tauri webview can leave the app when a user
follows an external link.
**Verdict:** the three reported vectors (middle click, drag-and-drop, raw
anchors) are **closed and covered by tests**, and verified in a real Chromium
engine. One class remains open by design decision: **script-driven
navigation** (`location.href = 'https://…'`) and the engine's own native context
menu, which need a Rust-level navigation handler (see Residual risks).

## 1. What existed before

| Exit | State |
|---|---|
| Left click on `ExternalUrlLink` | Routed to `open_external` via IPC — correct |
| Left click on **any other** `<a href="https://…">` | Navigated the webview to the remote page |
| **Middle click** on any external anchor | `auxclick` was unhandled — WebView2 opens a new window, Tauri renders it in-app |
| **Ctrl/Cmd/Shift+click** on an anchor not wrapped by the component | Same navigation, since only the component's `onClick` existed |
| **Link dropped onto the page** | Engine-level navigation; no `drop`/`dragover` handler anywhere |
| `window.open` | Only inside `openExternalUrl`'s web-mode fallback; no other call sites |
| `<iframe>`, `<object>`, external `<form action>` | None in the codebase |
| Internal anchors (`/ip`, `/vpn`, `/events`) | In-app; Tauri's asset resolver falls back to `index.html` (`tauri-2.11.5/src/manager/mod.rs:416-424`), so these are not a navigation-away risk |

The inventory came from grepping `apps/web/src` for `<a`, `href=`,
`window.open`, `location.href`, `target="_blank"`, `onDrop`/`dataTransfer`,
`<iframe`, `<form`. Every external anchor in the app renders through
`ExternalUrlLink` today; the gap was the activation paths the component never
saw.

## 2. What changed

- **`apps/web/src/lib/externalNavigation.ts` (new).**
  `installExternalNavigationGuard()` adds four **capture-phase** listeners on the
  document: `click`, `auxclick`, `dragover`, `drop`.
  - A `click` (any modifier) or `auxclick` (button 1) whose target resolves,
    via `closest('a[href]')`, to an absolute `http(s)` URL on **another
    origin** is `preventDefault()`ed and handed to `openExternalUrl`.
  - Same-origin routes, `#fragments` and non-web schemes are left alone.
  - `dragover` cancels link (`text/uri-list`) and file (`Files`) payloads;
    `drop` cancels them, opens an http(s) URL externally, and refuses an in-app
    link drop without navigating. Plain-text dragover is **not** cancelled, so
    dragging text into an input still works; a URL dropped as `text/plain` is
    still caught on `drop`.
  - Idempotent (symbol keyed on the document, safe across Vite HMR) and returns
    a disposer for tests.
- **`apps/web/src/main.tsx`** installs the guard before the first render, so a
  link in the first frame cannot navigate the app away.
- **`apps/web/src/components/ui/ExternalUrlLink.tsx`** now skips its own call
  when the event is already `defaultPrevented` (otherwise both the guard and
  the component would open the URL — two browser tabs), and handles `auxclick`
  itself for the case where the guard is not installed.

Not changed: no Rust code, no `tauri.conf.json`, no capabilities. Reverting the
three files above restores the previous behaviour exactly.

## 3. Evidence

### 3.1 Unit/component tests — 18 passing

`apps/web/test/externalNavigation.test.ts` (14): classification (external,
same-origin, `#hash`, `mailto:`, `javascript:`, malformed), left click, ctrl
click, middle click, right-click ignored, in-app click untouched, external
drop, in-app drop refused without opening, plain-text drop left alone, URL as
`text/plain`, `dragover` for links/files, idempotent install and disposal.

`apps/web/test/externalUrlLink.test.tsx` (4): one open per activation with the
guard installed, middle click, href/target/rel retained.

Full web suite: **377 tests / 45 files pass**. `tsc --noEmit` clean, ESLint
clean on every touched file.

### 3.2 Real Chromium (Vite dev server, devtools protocol)

With the app running and `window.open` stubbed to record calls:

| Action | `defaultPrevented` | Opener calls | Destination |
|---|---|---|---|
| Left click, raw external anchor | true | 1 | `https://example.test/raw-anchor` |
| Middle click (`auxclick` 1) | true | 2 | same |
| Ctrl+click | true | 3 | same |
| Link dropped (`DataTransfer` `text/uri-list`) | true | 4 | `https://example.test/dropped#frag` (fragment kept) |
| `dragover` with a link | true | — | navigation refused before drop |
| In-app `/ip` click | **false** | 0 extra | left to the router |
| Page location after all of the above | — | — | unchanged |

The real-engine run is what makes the jsdom tests credible: `auxclick` and
`DragEvent` with a real `DataTransfer` are engine behaviours, not DOM stubs.

## 4. Residual risks

1. **Script-driven navigation is not intercepted.** `location.href = 'https://…'`
   (or an anchor activated after the guard is bypassed by a future refactor)
   still navigates the webview, because Tauri 2.11.5 has no page-level
   `on_navigation` hook on a config-created window. Closing it means creating
   the main window in Rust with
   `WebviewWindowBuilder::from_config(app, &cfg).on_navigation(...).on_new_window(...)`
   and removing the `windows` entry from `tauri.conf.json`. That restructures
   window creation — the area `window.rs` documents as fragile on Windows
   (startup minimisation) — and could not be runtime-verified in this
   environment, so it is recommended as a separate, reviewable change rather
   than folded into this fix. Until then the guard is the only line.
2. **Native context menu.** WebView2's "Open link in new window" is an engine
   menu action, not a DOM event; the guard cannot see it. It is the same
   in-app-window symptom as middle click.
3. **`withGlobalTauri: true`.** The Tauri global is injected into every document
   in the webview; a remote page loaded by (1) would hold the object. Tauri is
   expected to deny IPC to remote origins, but that was not verified here.
4. `drop` of a file is refused (navigation prevented) but there is no file-drop
   feature to preserve; if one is added it must handle the payload before this
   guard.

## 5. Rollback

Revert the three source files and delete the guard module and its test. No
persistent state, no migration, no configuration.
