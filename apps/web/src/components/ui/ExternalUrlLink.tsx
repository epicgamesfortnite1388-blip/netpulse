import type { MouseEvent, ReactNode } from 'react';

import { openExternalUrl } from '@/lib/openExternal';

/**
 * An anchor to an external site that opens through the OS, not the webview.
 *
 * The packaged app is a Tauri webview: an ordinary link (or `window.open`)
 * either navigates the app away from itself or lands in an in-app window that
 * cannot hand `https://` URLs to the user's real browser, protocol handlers
 * (`t.me`) included. Desktop mode therefore prevents the anchor's default and
 * calls the Rust `open_external` command through `openExternalUrl`; web/dev mode
 * keeps the normal new-tab behavior inside that helper.
 *
 * The `href` stays on the element so the target is still visible on hover,
 * copyable, and reachable if scripting fails.
 *
 * The document-level guard in `lib/externalNavigation` also classifies every
 * anchor activation (middle-click, keyboard, links from data). It runs first,
 * in the capture phase, and calls `preventDefault()` — hence the
 * `defaultPrevented` check here, which keeps one activation from opening two
 * browser tabs. The handler still owns the component when the guard is absent
 * (unit tests, an embed of this component elsewhere).
 */
export function ExternalUrlLink({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    openExternalUrl(href);
  };

  return (
    <a
      href={href}
      className={className}
      title={title}
      target="_blank"
      rel="noreferrer"
      onClick={activate}
      onAuxClick={(event) => {
        if (event.button === 1) activate(event);
      }}
    >
      {children}
    </a>
  );
}
