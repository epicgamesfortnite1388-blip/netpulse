/**
 * Collapsible-section policy.
 *
 * Every surface in this app is a stack of sections, and a stack of eight
 * equally-open sections is what makes a page feel complicated. Folding them is
 * therefore a UI state the app must own deliberately, not per component:
 *
 *   - an id + a scope produce the storage key, so two pages can both have a
 *     section called "Advanced" without sharing state,
 *   - a section that the user has never touched opens or folds by its own
 *     declared default (primary content opens, diagnostics/advanced folds),
 *   - a page-level Expand all / Collapse all moves every section EXCEPT the ones
 *     marked pinned — primary content must never be hidden by a page action.
 *
 * The React binding lives in `components/ui/Disclosure.tsx`; this module is pure
 * so the rules can be tested without rendering anything.
 */

/** Namespace so an unrelated `np.ui.*` entry can never collide with a section. */
export const DISCLOSURE_KEY_PREFIX = 'disclosure:';

export interface DisclosureSpec {
  /** Stable, unique within its scope (a page or a surface). */
  id: string;
  /** Open state before the user has chosen. */
  defaultOpen: boolean;
  /**
   * Primary content (the thing the page exists for): a page-level fold must not
   * hide it, and the section keeps its own default when the page folds.
   */
  pinned?: boolean;
  /** Key the user's choice is stored under; defaults to `id`. */
  storageId?: string;
}

/** Where one section's open state is persisted. */
export function disclosureKey(scope: string, spec: DisclosureSpec): string {
  return `${DISCLOSURE_KEY_PREFIX}${scope}:${spec.storageId ?? spec.id}`;
}

/**
 * The open state to render: an explicit stored choice always wins, otherwise the
 * section's own default. Stored values that are not booleans (older builds,
 * hand-edited storage) fall back to the default rather than guessing.
 */
export function resolveOpen(spec: DisclosureSpec, stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : spec.defaultOpen;
}

/** Sections a page-level Expand all / Collapse all is allowed to move. */
export function toggleableSections(specs: DisclosureSpec[]): string[] {
  return specs.filter((s) => !s.pinned).map((s) => s.id);
}

/** Whether a broadcast from the page control should skip this section. */
export function ignoresScopeBroadcast(spec: DisclosureSpec): boolean {
  return spec.pinned === true;
}

/** How many sections a fold leaves open, for the control's own label/hint. */
export function pinnedCount(specs: DisclosureSpec[]): number {
  return specs.filter((s) => s.pinned === true).length;
}

/**
 * A section's summary line while folded. Collapsing must not hide *what
 * matters*, so the header keeps a live badge and one short line of counts; an
 * empty summary stays empty rather than inventing a placeholder.
 */
export function foldedSummary(summary: string | undefined): string | null {
  const text = (summary ?? '').trim();
  return text.length > 0 ? text : null;
}
