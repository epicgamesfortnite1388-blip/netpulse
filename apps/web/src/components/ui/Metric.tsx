import { fmtMs, fmtMbps, fmtPct } from '@/lib/format';
import { Tooltip } from '@/components/ui/Tooltip';

import type { ReactNode } from 'react';

export type MetricUnit = 'ms' | 'mbps' | 'pct' | 'raw';

function format(value: number | null, unit: MetricUnit): string {
  switch (unit) {
    case 'ms':
      return fmtMs(value);
    case 'mbps':
      return fmtMbps(value);
    case 'pct':
      return fmtPct(value);
    default:
      return value == null ? '—' : String(Math.round(value * 100) / 100);
  }
}

export function Metric({
  label,
  value,
  unit = 'raw',
  hint,
  status = 'idle',
  size = 'md',
  children,
}: {
  label: string;
  value: number | null;
  unit?: MetricUnit;
  hint?: string;
  /** idle = awaiting first measurement */
  status?: 'good' | 'warn' | 'bad' | 'idle';
  /**
   * `md` (20px) is the reading size for a row of metrics; `lg` (24px) is for a
   * single focal result. Before this existed every metric was 24px, so a strip
   * of six supporting numbers outranked the page's headline verdict.
   */
  size?: 'md' | 'lg';
  children?: ReactNode;
}) {
  const valueColor =
    status === 'good'
      ? 'text-text'
      : status === 'warn'
        ? 'text-warn'
        : status === 'bad'
          ? 'text-danger'
          : 'text-faint';

  const body = (
    <div>
      <div className="text-micro font-medium uppercase tracking-[0.12em] text-faint">{label}</div>
      <div className={`metric-num mt-1 font-semibold ${size === 'lg' ? 'text-2xl' : 'text-xl'} ${valueColor}`}>
        {format(value, unit)}
      </div>
      {children}
    </div>
  );

  if (hint) {
    // The trigger must be focusable or the hint is pointer-only. Radix wires
    // aria-describedby from the trigger, so making the wrapper focusable is the
    // whole fix: the hint now appears on keyboard focus as well as hover.
    return (
      <Tooltip content={hint}>
        <div className="cursor-help rounded-sm" tabIndex={0}>
          {body}
        </div>
      </Tooltip>
    );
  }
  return body;
}
