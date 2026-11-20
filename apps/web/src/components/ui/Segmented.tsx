import { useRef } from 'react';

import { TAB_LIST_CLASS, tabTriggerClass } from './tabStyles';

import type { KeyboardEvent, ReactNode } from 'react';

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
 *
 * ## Keyboard
 *
 * A radiogroup is ONE tab stop, not N: Tab enters the group on the checked
 * option, arrows move the selection, Tab leaves. Plain buttons would make every
 * option a stop and leave the arrow keys doing nothing, which is the difference
 * between a control that looks like a radio group and one that behaves like it
 * (WAI-ARIA APG, radio group pattern). Home/End jump to the ends.
 */
export function Segmented<T extends string | number>({
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
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function move(from: number, delta: number) {
    const count = items.length;
    if (count === 0) return;
    const next = (from + delta + count) % count;
    const target = items[next];
    if (!target) return;
    onChange(target.value);
    refs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home': {
        event.preventDefault();
        const first = items[0];
        if (first) {
          onChange(first.value);
          refs.current[0]?.focus();
        }
        break;
      }
      case 'End': {
        event.preventDefault();
        const lastIndex = items.length - 1;
        const last = items[lastIndex];
        if (last) {
          onChange(last.value);
          refs.current[lastIndex]?.focus();
        }
        break;
      }
      default:
        break;
    }
  }

  // When the controlled value is not one of the items (a stale stored value),
  // keep the group in the tab order by making the first option the stop.
  const hasChecked = items.some((item) => item.value === value);

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`${TAB_LIST_CLASS} ${className}`}>
      {items.map((item, index) => {
        const active = item.value === value;
        const isStop = active || (!hasChecked && index === 0);
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={isStop ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={tabTriggerClass(size, active)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
