import { TAB_LIST_CLASS, tabTriggerClass } from './tabStyles';

import type { ReactNode } from 'react';

/**
 * A segmented control — the filter counterpart to `Tabs`.
 *
 * `Tabs` swaps content panels; this only changes which filter the single view
 * below it applies, so the controlled view is rendered once instead of being
 * duplicated per option.
 *
 * It uses the same chrome as `Tabs` on purpose: to a user these are the same
 * control doing the same job, and they sat next to each other on the Node
 * Explorer looking like two different products. The roles stay distinct —
 * a radiogroup is not a tablist — because that difference is real to a screen
 * reader even though it must be invisible on screen.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  ariaLabel,
  size = 'md',
  className = '',
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: ReactNode }>;
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`${TAB_LIST_CLASS} ${className}`}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(item.value)}
            className={tabTriggerClass(size, active)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
