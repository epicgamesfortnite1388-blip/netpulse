/**
 * NetPulse identity mark — one baseline, one spike.
 *
 * The previous mark was a rounded gradient tile with a glow. This one is a
 * flat, engraved instrument glyph: no gradient, no glass, no glow, no loop.
 * The spike is the pulse; the baseline is the network. It scales from the rail
 * (28px) to the about/empty states (56px) without losing its shape.
 */
export function PulseMark({ size = 30 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-[6px] border"
      style={{
        width: size,
        height: size,
        borderColor: 'color-mix(in srgb, var(--color-accent) 42%, transparent)',
        background: 'var(--color-accent-soft)',
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.7} height={size * 0.7} fill="none">
        <path
          d="M2 12h4.2l2.3-6.6 3.3 13.2 2.7-9.2 1.8 2.6H22"
          stroke="var(--color-accent)"
          strokeWidth={Math.max(1.5, size * 0.055)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
