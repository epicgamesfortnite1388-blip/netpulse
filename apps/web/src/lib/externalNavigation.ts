/**
 * One document-level guard for every way a webview can leave the app.
 *
 * `ExternalUrlLink` and `openExternalUrl` cover the obvious case — a left click
 * on an anchor that a component remembered to route through them. A webview has
 * more exits than that, and WebView2/WebKit take them without asking React:
 *
 *   - **middle click** (`auxclick`) opens a new window, which Tauri renders as
 *     an in-app webview with no browser chrome and no protocol handler for the
 *     destination (`t.me` included);
 *   - **dragging a link onto the page** is a navigation handled by the engine,
 *     not by any click handler;
 *   - **raw anchors** — including ones added later, or links rendered from
 *     data — navigate the whole app away from itself if a component forgets to
 *     use `ExternalUrlLink`;
 *   - **ctrl/cmd/shift+click**, and **Enter** on a focused anchor, are ordinary
 *     `click`s that a component may not have anticipated.
 *
 * So the guard is installed once, in the capture phase, on the document: every
 * anchor activation and every dropped link is classified in one place. An
 * absolute `http(s)` URL on another origin goes through `openExternalUrl` (the
 * Rust `open_external` command in the packaged app, a new tab on the web);
 * everything else — same-origin routes, `#fragments`, non-web schemes — is left
 * to the app.
 *
 * It deliberately does not `stopPropagation`: the anchor stays focusable and
 * `ExternalUrlLink` still sees the event, but `preventDefault()` marks it as
 * handled so the component can skip its own call (`defaultPrevented`) instead
 * of opening the same URL twice.
 */

import { openExternalUrl } from './openExternal';

/** Absolute http(s) URL on another origin, or `null` for anything in-app. */
export function externalTarget(raw: string | null | undefined, baseHref?: string): URL | null {
  if (!raw) return null;
  const base = baseHref ?? (typeof window !== 'undefined' ? window.location.href : undefined);
  if (!base) return null;
  let url: URL;
  let here: URL;
  try {
    url = new URL(raw, base);
    here = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === here.origin) return null;
  return url;
}

/** The first real URL in a `text/uri-list` payload (comments start with `#`). */
function firstUriListEntry(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return null;
}

/**
 * A dragged link arrives as `text/uri-list`; some engines also offer the URL as
 * `text/plain`. Plain prose drops are left alone so text fields keep working.
 */
function droppedUrl(data: DataTransfer | null): string | null {
  if (!data) return null;
  const kinds = Array.from(data.types ?? []);
  if (kinds.includes('text/uri-list')) {
    const list = data.getData('text/uri-list');
    if (list) return firstUriListEntry(list);
  }
  if (kinds.includes('text/plain')) {
    const text = data.getData('text/plain').trim();
    if (text && externalTarget(text)) return firstUriListEntry(text) ?? text;
  }
  return null;
}

/**
 * Payloads whose default drop action is "navigate" (a link) or "load" (a
 * file). Plain text is deliberately NOT cancelled on dragover: doing so would
 * stop a user dragging selected text into a search field, and every browser
 * this app ships in sends `text/uri-list` for a link drag.
 */
function carriedNavigation(data: DataTransfer | null): boolean {
  if (!data) return false;
  const kinds = Array.from(data.types ?? []);
  return kinds.includes('text/uri-list') || kinds.includes('Files');
}

const GUARD_KEY = Symbol.for('netpulse.external-navigation-guard');

/**
 * Install the guard on `doc` (defaults to the current document).
 *
 * Idempotent: a second call returns the existing disposer instead of adding a
 * second listener, which matters because a Vite HMR update can re-execute the
 * entry module.
 */
export function installExternalNavigationGuard(doc: Document = document): () => void {
  const holder = doc as unknown as Record<symbol, (() => void) | undefined>;
  const already = holder[GUARD_KEY];
  if (already) return already;

  const onActivate = (event: MouseEvent): void => {
    if (event.defaultPrevented) return;
    if (event.type === 'click' && event.button !== 0) return;
    if (event.type === 'auxclick' && event.button !== 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (!anchor) return;
    const url = externalTarget(anchor.getAttribute('href'), doc.baseURI);
    if (!url) return;
    event.preventDefault();
    openExternalUrl(url.toString());
  };

  const onDragOver = (event: DragEvent): void => {
    // The engine's default for a dragged link (or file) is "navigate to it".
    // Refuse that for every such payload, in-app origin included.
    if (carriedNavigation(event.dataTransfer)) event.preventDefault();
  };

  const onDrop = (event: DragEvent): void => {
    const raw = droppedUrl(event.dataTransfer);
    if (!raw) return;
    event.preventDefault();
    const url = externalTarget(raw, doc.baseURI);
    if (url) openExternalUrl(url.toString());
  };

  doc.addEventListener('click', onActivate, true);
  doc.addEventListener('auxclick', onActivate, true);
  doc.addEventListener('dragover', onDragOver, true);
  doc.addEventListener('drop', onDrop, true);

  const dispose = (): void => {
    doc.removeEventListener('click', onActivate, true);
    doc.removeEventListener('auxclick', onActivate, true);
    doc.removeEventListener('dragover', onDragOver, true);
    doc.removeEventListener('drop', onDrop, true);
    delete holder[GUARD_KEY];
  };
  holder[GUARD_KEY] = dispose;
  return dispose;
}
