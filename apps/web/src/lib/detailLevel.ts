/**
 * Progressive disclosure — the four-level policy.
 *
 * ## The problem this solves
 *
 * The app is a stack of sections, and the earlier pass made each one foldable.
 * Folding answers "is this section open?", not "should this section exist for
 * *this* reader?". A first-time user and a network engineer were shown the same
 * page and had to triage it themselves: the dashboard was ~2 screens tall at
 * 1440px, and the only way to reduce it was to fold eight sections by hand.
 *
 * Four levels separate those two questions:
 *
 *   1 Essential  the verdict, and what to do next
 *   2 Context    the evidence that makes the verdict believable
 *   3 Advanced   the measurements an engineer wants when something is wrong
 *   4 Expert     raw provenance: events, stages, distributions
 *
 * A level is a *ceiling on detail*, not a set of tabs. Content declares the
 * minimum level at which it becomes relevant; the reader picks how deep to go.
 * Folding still applies on top — a Level 3 section that the user has folded
 * stays folded, so the two mechanisms compose instead of competing.
 *
 * ## The rules, stated so they can be enforced
 *
 * - **Essential content is never gated.** Warnings, failures and the primary
 *   action are rendered at every level. A level may not hide something the user
 *   must act on.
 * - **Nothing is silently hidden.** Whenever content is suppressed, the control
 *   says so ("2 more sections at Advanced"), so the reader knows depth exists.
 * - **The choice is remembered per page**, and only per page: opening Expert on
 *   Diagnostics must not turn the dashboard into a wall of events.
 * - **An unknown stored value falls back to the page default** rather than
 *   guessing, the same rule the fold state uses.
 *
 * This module is pure so the rules can be tested without rendering anything. The
 * React binding is `components/ui/DetailLevel.tsx`.
 */

export type DetailLevel = 1 | 2 | 3 | 4;

export const DETAIL_LEVELS: readonly DetailLevel[] = [1, 2, 3, 4];

export type DetailLevelId = 'essential' | 'context' | 'advanced' | 'expert';

export interface DetailLevelMeta {
  level: DetailLevel;
  id: DetailLevelId;
  /** Shown in the control. Short enough for four of them to sit on one line. */
  label: string;
  /** The contract for what belongs at this level. */
  summary: string;
}

export const DETAIL_LEVEL_META: Record<DetailLevel, DetailLevelMeta> = {
  1: {
    level: 1,
    id: 'essential',
    label: 'Essential',
    summary: 'The current state, the result that matters, and the next action.',
  },
  2: {
    level: 2,
    id: 'context',
    label: 'Context',
    summary: 'The measurements and evidence that make the result believable.',
  },
  3: {
    level: 3,
    id: 'advanced',
    label: 'Advanced',
    summary: 'Per-stage detail: probes, timings, strategy decisions, recovery.',
  },
  4: {
    level: 4,
    id: 'expert',
    label: 'Expert',
    summary: 'Raw provenance: event history, distributions, technical failures.',
  },
};

/** Namespace so a level choice can never collide with a fold or a setting. */
export const DETAIL_KEY_PREFIX = 'detail:';

export function detailKey(scope: string): string {
  return `${DETAIL_KEY_PREFIX}${scope}`;
}

/** Coerce anything (a number, a numeric string, garbage) to a valid level. */
export function clampLevel(value: unknown): DetailLevel | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= 1 && rounded <= 4 ? (rounded as DetailLevel) : null;
}

/**
 * The level to render: an explicit stored choice wins, otherwise the page's own
 * default. Unrecognised stored values fall back rather than guessing — the same
 * contract as `resolveOpen` for folds.
 */
export function resolveDetailLevel(stored: unknown, fallback: DetailLevel): DetailLevel {
  return clampLevel(stored) ?? fallback;
}

/**
 * Whether content that requires `required` is visible at `current`.
 *
 * A lower requirement is always visible at a higher level, so raising the level
 * only ever adds content — it never swaps one panel for another. That property
 * is what makes the control predictable, and it is asserted in the tests.
 */
export function isVisible(required: DetailLevel, current: DetailLevel): boolean {
  return required <= current;
}

/** Sections suppressed at `current`, for the "N more at <level>" affordance. */
export function suppressedCount(requiredLevels: readonly DetailLevel[], current: DetailLevel): number {
  return requiredLevels.filter((r) => !isVisible(r, current)).length;
}

/**
 * The shallowest level above `current` that would reveal something, or null when
 * nothing is hidden. Drives the control's hint so a reader is never left
 * wondering whether depth exists.
 */
export function nextLevelWithContent(requiredLevels: readonly DetailLevel[], current: DetailLevel): DetailLevel | null {
  const hidden = requiredLevels.filter((r) => !isVisible(r, current)).sort((a, b) => a - b);
  return hidden[0] ?? null;
}

/**
 * The deepest level that any content on the page actually requires.
 *
 * The control only offers levels up to this depth. A four-option control on a
 * page whose content stops at Context would leave two options that change
 * nothing when clicked, which reads as a broken control rather than as a page
 * with less to say. Pages are allowed to be shallow; the control follows the
 * page instead of the page being padded to fill the control.
 *
 * Returns 1 for a page with no requirements at all, i.e. the shallowest level
 * that is always true.
 */
export function deepestLevel(requiredLevels: readonly DetailLevel[]): DetailLevel {
  let deepest: DetailLevel = 1;
  for (const level of requiredLevels) if (level > deepest) deepest = level;
  return deepest;
}

/**
 * The levels the control should offer: every level from Essential down to the
 * deepest one this page uses.
 *
 * Always non-empty — Essential is offered even on a page with no gated content,
 * so the control's shape does not change as gates mount and unmount.
 */
export function offeredLevels(requiredLevels: readonly DetailLevel[]): DetailLevel[] {
  const deepest = deepestLevel(requiredLevels);
  return DETAIL_LEVELS.filter((level) => level <= deepest);
}

/**
 * The level a page should open at when the reader has no stored choice.
 *
 * Essential is the system default, because a first-time reader should meet the
 * verdict before the evidence. Pages whose essential content is not enough to
 * act on declare a deeper start; they pass it explicitly so the decision is
 * visible in that page's source rather than hidden in this module.
 */
export const DEFAULT_DETAIL_LEVEL: DetailLevel = 1;
