import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one guard that owns every way the webview can leave the app.
 *
 * `ExternalUrlLink` only sees activations a component routed through it. A
 * webview also has middle-click (`auxclick`), ctrl/cmd+click, keyboard
 * activation, and a link dragged onto the page — all of which navigate or open
 * an in-app window without asking React. These tests pin the classification
 * (external vs in-app) and each of those exits, because the failure mode is
 * silent: the app simply loads someone else's page inside its own frame.
 */
const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/openExternal', () => ({ openExternalUrl }));

const { externalTarget, installExternalNavigationGuard } = await import('../src/lib/externalNavigation');

let dispose: (() => void) | null = null;

function anchor(href: string, text = 'link'): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  document.body.appendChild(a);
  return a;
}

/** A drag payload: jsdom has no DataTransfer, so model the two methods we use. */
function dragEvent(type: string, data: Record<string, string>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: Object.keys(data),
      getData: (kind: string) => data[kind] ?? '',
    },
  });
  return event;
}

beforeEach(() => {
  openExternalUrl.mockReset();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.replaceChildren();
});

describe('externalTarget', () => {
  it('treats another origin as external', () => {
    expect(externalTarget('https://github.com/example')?.toString()).toBe('https://github.com/example');
    expect(externalTarget('http://example.test/')?.toString()).toBe('http://example.test/');
  });

  it('leaves in-app navigation alone', () => {
    expect(externalTarget('/ip')).toBeNull();
    expect(externalTarget('#section')).toBeNull();
    expect(externalTarget('/vpn?tab=proxies')).toBeNull();
    expect(externalTarget(`${window.location.origin}/nodes/12`)).toBeNull();
  });

  it('ignores non-web schemes and junk', () => {
    expect(externalTarget('mailto:someone@example.test')).toBeNull();
    expect(externalTarget('javascript:alert(1)')).toBeNull();
    expect(externalTarget('')).toBeNull();
    expect(externalTarget('http://[unclosed')).toBeNull();
  });
});

describe('installExternalNavigationGuard', () => {
  beforeEach(() => {
    dispose = installExternalNavigationGuard();
  });

  it('sends a left click on any external anchor to the OS opener', () => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor('https://github.com/example').dispatchEvent(event);

    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/example');
    expect(event.defaultPrevented).toBe(true);
  });

  it('covers anchors the app never wrapped (raw or data-driven links)', () => {
    const link = anchor('https://t.me/AbystralBot?start=x');
    link.addEventListener('click', () => {}, { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));

    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://t.me/AbystralBot?start=x');
  });

  it('sends a middle click to the OS opener instead of opening an in-app window', () => {
    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    anchor('https://example.test/status').dispatchEvent(event);

    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/status');
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores right clicks and in-app links', () => {
    anchor('https://example.test/status').dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }),
    );
    const internal = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor('/ip').dispatchEvent(internal);

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(internal.defaultPrevented).toBe(false);
  });

  it('refuses a link dropped onto the page and opens it externally', () => {
    const event = dragEvent('drop', { 'text/uri-list': '# comment\r\nhttps://example.test/dropped\r\n' });
    document.dispatchEvent(event);

    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/dropped');
    expect(event.defaultPrevented).toBe(true);
  });

  it('still refuses an in-app link drop (no reload, no navigation)', () => {
    const event = dragEvent('drop', { 'text/uri-list': `${window.location.origin}/ip` });
    document.dispatchEvent(event);

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves ordinary text drops alone so inputs keep working', () => {
    const event = dragEvent('drop', { 'text/plain': 'just some words' });
    document.dispatchEvent(event);

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('cancels dragover for links and files before the engine treats it as navigation', () => {
    const linkDrag = dragEvent('dragover', { 'text/uri-list': 'https://example.test' });
    document.dispatchEvent(linkDrag);
    const fileDrag = dragEvent('dragover', { Files: '' });
    document.dispatchEvent(fileDrag);

    expect(linkDrag.defaultPrevented).toBe(true);
    expect(fileDrag.defaultPrevented).toBe(true);
  });

  it('leaves text/plain dragover alone so dragging text into a field still works', () => {
    const textDrag = dragEvent('dragover', { 'text/plain': 'hello' });
    document.dispatchEvent(textDrag);

    expect(textDrag.defaultPrevented).toBe(false);
  });

  it('refuses a URL dropped as plain text too (engines that omit uri-list)', () => {
    const event = dragEvent('drop', { 'text/plain': 'https://example.test/plain-drag' });
    document.dispatchEvent(event);

    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/plain-drag');
    expect(event.defaultPrevented).toBe(true);
  });

  it('is idempotent and removable', () => {
    const second = installExternalNavigationGuard();
    expect(second).toBe(dispose);

    anchor('https://example.test/once').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openExternalUrl).toHaveBeenCalledTimes(1);

    dispose?.();
    dispose = null;
    anchor('https://example.test/after').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
  });
});
