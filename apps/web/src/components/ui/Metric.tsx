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
  children,
}: {
  label: string;
  value: number | null;
  unit?: MetricUnit;
  hint?: string;
  /** idle = awaiting first measurement */
  status?: 'good' | 'warn' | 'bad' | 'idle';
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
      <div className={`metric-num mt-1 text-2xl font-semibold ${valueColor}`}>{format(value, unit)}</div>
      {children}
    </div>
  );

  if (hint) {
    return (
      <Tooltip content={hint}>
        <div className="cursor-help">{body}</div>
      </Tooltip>
    );
  }
  return body;
}
