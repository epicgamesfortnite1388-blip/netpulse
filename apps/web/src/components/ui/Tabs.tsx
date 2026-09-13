import * as RTabs from '@radix-ui/react-tabs';

import type { ReactNode } from 'react';

export function Tabs({
  items,
  children,
  defaultValue,
  value,
  onValueChange,
}: {
  /** each item: value + label */
  items: { value: string; label: string }[];
  children: ReactNode;
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
}) {
  return (
    <RTabs.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange}>
      <RTabs.List className="mb-5 flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
        {items.map((item) => (
          <RTabs.Trigger
            key={item.value}
            value={item.value}
            className="rounded-lg px-3.5 py-1.5 text-sm text-muted transition-colors hover:text-text data-[state=active]:bg-accent-soft data-[state=active]:text-accent-strong"
          >
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
    <RTabs.Content value={value} className="animate-fade-up focus-visible:outline-none">
      {children}
    </RTabs.Content>
  );
}
