/** Radial score gauge, 0-100. Custom SVG for full visual control. */
export function Gauge({
  value,
  label,
  size = 180,
}: {
  value: number | null;
  label?: string;
  size?: number;
}) {
  const stroke = 10;
  const r = (size - stroke) / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  // 270-degree arc
  const arc = 0.75;
  const clamped = value == null ? 0 : Math.max(0, Math.min(100, value));
  const filled = clamped / 100;
  const dash = circumference * arc * filled;
  const gap = circumference * (1 - arc);

  const color =
    value == null
      ? 'var(--color-faint)'
      : clamped >= 85
        ? 'var(--color-ok)'
        : clamped >= 70
          ? 'var(--color-accent)'
          : clamped >= 50
            ? 'var(--color-warn)'
            : 'var(--color-danger)';

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-[225deg]">
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="rgba(148,163,184,0.12)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * arc} ${gap}`}
        />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          style={{ transition: 'stroke-dasharray 0.8s cubic-bezier(0.22,1,0.36,1), stroke 0.4s' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="metric-num text-4xl font-semibold" style={{ color: value == null ? 'var(--color-faint)' : 'var(--color-text)' }}>
          {value == null ? '—' : Math.round(value)}
        </span>
        <span className="mt-0.5 text-micro font-medium uppercase tracking-[0.14em] text-faint">
          {label ?? 'of 100'}
        </span>
      </div>
    </div>
  );
}
