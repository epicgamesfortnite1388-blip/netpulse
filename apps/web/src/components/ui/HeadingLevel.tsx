import { createContext, useContext } from 'react';

import type { ReactNode } from 'react';

/**
 * Where a heading sits in the page outline, owned in one place.
 *
 * The audit found `h2` on zero of 21 pages: every page had exactly one `h1`
 * (PageHeader) and then jumped straight to `h3` for every card, so the document
 * outline a screen reader can navigate by had no second level at all.
 *
 * Fixing that by hand means every card in the app grows a `level` prop and stays
 * correct only until someone nests one. Instead the rank is DERIVED from
 * structure: the page is level 1, each `Card` opens the next level, and
 * `CardHeader` renders whatever rank it was handed. Nest a card in a card and
 * the outline deepens on its own — no page-level bookkeeping, and no way for the
 * structure and the markup to disagree.
 *
 * The default is 2 because that is the truth for every route: a page title is an
 * `h1`, so the first section below it is an `h2`. Pages that render their own
 * `h1` (or are visually headed without one) need no special case.
 */
const HeadingLevelContext = createContext(2);

/** Provide the level that cards nested inside this subtree should render. */
export function HeadingLevelProvider({ level, children }: { level: number; children: ReactNode }) {
  return <HeadingLevelContext.Provider value={level}>{children}</HeadingLevelContext.Provider>;
}

/** The rank the next heading rendered in this subtree should use. */
export function useHeadingLevel(): number {
  return useContext(HeadingLevelContext);
}

/** Clamp to the levels HTML actually defines, so a deep tree cannot emit `h9`. */
export function headingTag(level: number): 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  return `h${Math.min(6, Math.max(2, level))}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}