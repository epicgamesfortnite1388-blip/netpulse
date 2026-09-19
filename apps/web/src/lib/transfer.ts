/**
 * Handing data out of the app to the operating system.
 *
 * Two primitives, both of which can fail quietly, so both report success instead
 * of throwing:
 *
 *   - `copyText` — clipboard write. `navigator.clipboard` is the right API but
 *     it is gated on a secure context and on the document having focus/user
 *     activation, so a plain-text copy falls back to a temporary selection +
 *     `execCommand('copy')`. A caller that gets `false` must say so; a copy
 *     button that looks like it worked is worse than one that admits it did not.
 *   - `downloadText` — saves text as a file. The Blob/anchor dance lived twice
 *     (node list and node detail) before this module existed.
 *
 * Everything that gets a config out of the app goes through one of these, so the
 * "did the OS actually receive it?" question has one answer per primitive.
 */

const FALLBACK_OFFSCREEN = 'position:fixed;top:-1000px;opacity:0;';

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through: an unfocused or non-activated document rejects here.
    }
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = FALLBACK_OFFSCREEN;
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Save `text` as `filename`. The download cannot report failure, so it does not pretend to. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
