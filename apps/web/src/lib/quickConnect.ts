/**
 * Quick-connect picker logic.
 *
 * Pure, React-free rules for the keyboard overlay, so the overlay itself only
 * renders: which nodes a query matches, how the active row moves, and which
 * text a row shows. Keeping them here means the keyboard behaviour is testable
 * without a DOM, and the candidate shape is documented in one place.
 */

/**
 * The subset of a node DTO the picker needs.
 *
 * No host/port: the server never sends a node's dial endpoint to the browser,
 * and the overlay only ever posts the id back.
 */
export interface QuickNode {
  id: string;
  /** Server-built display name; always non-empty. */
  label: string;
  protocol: string;
  country: string | null;
  city: string | null;
  remark: string | null;
  medianProxyMs: number | null;
  status: string;
}

/** Everything a token may match, lower-cased and joined once. */
export function quickNodeHaystack(node: QuickNode): string {
  return [node.label, node.protocol, node.country, node.city, node.remark]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .toLowerCase();
}

/**
 * Filter by every whitespace-separated token, in the order the server returned
 * (already fastest-tested first).
 *
 * The whole query as one substring would make "japan tokyo" match nothing even
 * though both words are on screen; token AND is what a user typing two words
 * expects. An empty query keeps the list — opening the overlay should show
 * candidates, not a blank panel.
 */
export function filterQuickNodes(nodes: readonly QuickNode[], query: string): QuickNode[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...nodes];
  return nodes.filter((node) => {
    const haystack = quickNodeHaystack(node);
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Move the active row by `delta`, wrapping at both ends.
 *
 * Wrapping matters here because the overlay opens with the first row selected:
 * ArrowUp from the top should reach the last candidate (the slowest one, still
 * possibly the right choice), not stall.
 */
export function stepActive(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  // Double modulo, not a `< 0` branch: `-1 % 1` is `-0` in JavaScript, which
  // passes `< 0` and would put `-0` into state (0 that logs and prints as -0).
  return ((index + delta) % length + length) % length;
}

/**
 * Which overlay a keypress asks for, if any.
 *
 * `Shift+K` still reports key `'k'`, so one decision has to own both bindings:
 * two independent listeners would open the palette underneath the quick-connect
 * overlay on Ctrl+Shift+K. Returns null for everything else, so the caller can
 * leave the browser's own shortcuts alone.
 */
export function overlayShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): 'palette' | 'quick-connect' | null {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return null;
  return e.shiftKey ? 'quick-connect' : 'palette';
}

/** The one-line meta a row shows next to its name: place, then measured latency. */
export function quickNodeMeta(node: QuickNode): string {
  const where = [node.city, node.country].filter((v): v is string => Boolean(v)).join(', ');
  const latency = node.medianProxyMs != null ? `${Math.round(node.medianProxyMs)} ms` : 'unmeasured';
  return [where || 'location unknown', latency].join(' · ');
}
