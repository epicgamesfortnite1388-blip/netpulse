import type { ReactNode } from 'react';

/**
 * A segmented control — the filter counterpart to `Tabs`.
 *
 * `Tabs` swaps content panels; this only changes which filter the single view
 * below it applies, so the controlled view is rendered once instead of being
 * duplicated per option. Visually it matches the Tabs list.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  ariaLabel,
  className = '',
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: ReactNode }>;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1 ${className}`}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(item.value)}
            className={`rounded-lg px-3.5 py-1.5 text-sm transition-colors ${
              active ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:text-text'
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
