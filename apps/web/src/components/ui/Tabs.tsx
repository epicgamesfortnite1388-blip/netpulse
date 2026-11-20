import * as RTabs from '@radix-ui/react-tabs';

import { TAB_LIST_CLASS, tabTriggerClass } from './tabStyles';

import type { ReactNode } from 'react';

/**
 * Section tabs: swaps which panel is rendered below.
 *
 * Radix owns the APG behaviour (roving tabindex, arrow keys, Home/End, correct
 * `tab`/`tabpanel` wiring) so no page has to re-implement it — NANI's
 * hand-rolled copy of exactly that logic was removed in favour of this.
 *
 * Use `Segmented` instead when the control only changes a filter over one view.
 */
export function Tabs({
  items,
  children,
  defaultValue,
  value,
  onValueChange,
  size = 'md',
  ariaLabel,
}: {
  /** Each item: value, label, optional leading icon. */
  items: { value: string; label: string; icon?: ReactNode }[];
  children: ReactNode;
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  /** `sm` for dense sets that must wrap without becoming a wall. */
  size?: 'sm' | 'md';
  /** Announced name for the tab group, e.g. "NANI sections". */
  ariaLabel?: string;
}) {
  return (
    <RTabs.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange}>
      <RTabs.List aria-label={ariaLabel} className={`mb-5 ${TAB_LIST_CLASS}`}>
        {items.map((item) => (
          <RTabs.Trigger
            key={item.value}
            value={item.value}
            className={`${tabTriggerClass(size)} data-[state=active]:bg-accent-soft data-[state=active]:font-semibold data-[state=active]:text-accent-strong`}
          >
            {item.icon}
            {item.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RTabs.Content value={value} className="focus-visible:outline-none">
      {children}
    </RTabs.Content>
  );
}
