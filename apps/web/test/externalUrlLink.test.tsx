import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * External links in the desktop UI must leave the webview.
 *
 * `window.open`/`target="_blank"` inside the Tauri webview opens an in-app
 * window (or gets dropped by the popup blocker) and cannot hand `https://` to
 * the user's real browser — `t.me` deep links in particular. Every external
 * anchor renders through `ExternalUrlLink`, which prevents the default and
 * calls the OS opener; this pins that behaviour at the click.
 */
const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/openExternal', () => ({ openExternalUrl }));

const { ExternalUrlLink } = await import('../src/components/ui/ExternalUrlLink');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function mount(href: string): Promise<HTMLAnchorElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ExternalUrlLink href={href} className="link" title="open it">
        Release notes
      </ExternalUrlLink>,
    );
  });
  const anchor = container.querySelector('a');
  if (!anchor) throw new Error('no anchor rendered');
  return anchor;
}

describe('ExternalUrlLink', () => {
  beforeEach(() => {
    openExternalUrl.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('hands the URL to the OS opener instead of letting the webview navigate', async () => {
    const anchor = await mount('https://github.com/example/releases');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/example/releases');
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens exactly once when the document guard handled the click first', async () => {
    // The guard (capture phase) calls preventDefault before React's handler
    // runs. Without the defaultPrevented check in the component this would
    // hand the same URL to the OS twice, i.e. two browser tabs.
    const { installExternalNavigationGuard } = await import('../src/lib/externalNavigation');
    const stop = installExternalNavigationGuard();
    try {
      const anchor = await mount('https://example.test/once');
      await act(async () => {
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });

      expect(openExternalUrl).toHaveBeenCalledTimes(1);
      expect(openExternalUrl).toHaveBeenCalledWith('https://example.test/once');
    } finally {
      stop();
    }
  });

  it('hands a middle click to the OS instead of letting the webview open a window', async () => {
    const anchor = await mount('https://example.test/middle');

    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    await act(async () => {
      anchor.dispatchEvent(event);
    });

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.test/middle');
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps the destination visible and copyable on the element', async () => {
    const anchor = await mount('https://example.test/status');

    expect(anchor.getAttribute('href')).toBe('https://example.test/status');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noreferrer');
    expect(anchor.className).toBe('link');
    expect(anchor.title).toBe('open it');
    expect(anchor.textContent).toBe('Release notes');
  });
});
