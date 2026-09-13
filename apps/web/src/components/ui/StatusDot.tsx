type Tone = 'ok' | 'warn' | 'danger' | 'offline' | 'idle';

const COLORS: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  offline: 'bg-faint',
  idle: 'bg-muted',
};

export function StatusDot({
  tone = 'idle',
  pulse = false,
  size = 8,
}: {
  tone?: Tone;
  pulse?: boolean;
  size?: number;
}) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${COLORS[tone]} ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
