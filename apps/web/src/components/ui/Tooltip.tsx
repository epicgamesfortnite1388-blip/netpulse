import * as RTooltip from '@radix-ui/react-tooltip';

import type { ReactNode } from 'react';

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  if (content == null) return <>{children}</>;
  return (
    <RTooltip.Root delayDuration={200}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-lg border border-line-strong bg-elevated px-3 py-2 text-xs leading-relaxed text-text shadow-floating"
        >
          {content}
          <RTooltip.Arrow className="fill-[#121b29]" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RTooltip.Provider delayDuration={200}>{children}</RTooltip.Provider>;
}
