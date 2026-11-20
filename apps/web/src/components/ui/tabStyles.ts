/**
 * One tab language for the whole product.
 *
 * Before this file there were three: `Tabs` (a bordered pill track at
 * `rounded-lg`), `Segmented` (the same track at `rounded-xl`), and NANI's
 * hand-rolled bar (a bottom-ruled row with a solid accent fill). The first two
 * were the same control with a different radius; the third made the product's
 * most important screen look like a different application.
 *
 * The chrome lives here so `Tabs` (panel switching) and `Segmented` (filter
 * switching) cannot drift again. They stay separate components because their
 * ARIA roles differ — a tablist and a radiogroup are not interchangeable — but
 * they must be indistinguishable to the eye.
 *
 * SIZE, not variant: `md` is the default for up to ~8 short labels; `sm` is for
 * dense sets (NANI's ten sections) where the row must still wrap gracefully.
 * There is deliberately no second visual variant — a product does not need two
 * ways to draw a tab.
 */

/** The recessed track the triggers sit in. */
export const TAB_LIST_CLASS =
  'flex flex-wrap items-center gap-1 rounded-[var(--np-r-3)] border border-line bg-surface-2/50 p-1';

/** A single trigger. Shared by tabs (button[role=tab]) and segments (button[role=radio]). */
export function tabTriggerClass(size: 'sm' | 'md' = 'md', active = false): string {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
  const dims = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  const state = active
    ? 'bg-accent-soft font-semibold text-accent-strong'
    : 'font-medium text-muted hover:bg-surface-3/60 hover:text-text';
  return `${base} ${dims} ${state}`;
}
