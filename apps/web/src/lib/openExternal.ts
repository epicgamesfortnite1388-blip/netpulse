/**
 * Open an https URL in the user's real browser.
 *
 * The packaged app is a Tauri webview, not a browser tab. `window.open` there
 * is subject to the webview's popup blocker (a call made after an `await` — a
 * Telegram deep link is only known once the worker answers — is the textbook
 * case it drops) and, when it does fire, opens an in-app window with no
 * protocol handler for `t.me`. The Rust `open_external` command is the one
 * path that hands the URL to the OS: https-only, credentials rejected, no
 * shell in the chain. DnsPage already uses it; this is the same decision in
 * one place for the rest of the app.
 *
 * Web/dev mode has no IPC, so it keeps the ordinary new-tab behavior.
 */

import { tauriInvoke } from './transport';

/** @returns `true` when the URL was handed to the OS, `false` in web mode. */
export function openExternalUrl(url: string): boolean {
  const invoke = tauriInvoke('open_external', { url });
  if (invoke) {
    // A refused URL (non-https, malformed) is already logged by the bridge;
    // the caller must never crash because a browser did not launch.
    invoke.catch(() => undefined);
    return true;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return false;
}
