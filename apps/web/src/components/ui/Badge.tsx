import type { ReactNode } from 'react';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  danger: 'bg-danger/10 text-danger border-danger/30',
  accent: 'bg-accent-soft text-accent-strong border-accent/30',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-micro font-medium leading-4 ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Persistent, honest marker for demo/synthetic data. */
export function DemoBadge() {
  return (
    <Badge tone="warn" className="uppercase tracking-wider">
      Demo data
    </Badge>
  );
}

export function PhaseBadge({ phase }: { phase: number }) {
  return (
    <Badge tone="accent" className="uppercase tracking-wider">
      Phase {phase}
    </Badge>
  );
}
