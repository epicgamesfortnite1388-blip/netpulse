/**
 * The NetPulse brand mark.
 *
 * A single rounded tile carrying the signature accent gradient and a pulse
 * waveform — the "network intelligence" idea reduced to one stroke. It is the
 * only place the gradient is painted at full strength; everything else (hero
 * hairline, focus glow) uses the same `brand-gradient` / `shadow-glow`
 * utilities so the identity stays consistent.
 *
 * Decorative by construction (`aria-hidden`): the mark never carries meaning a
 * screen reader would need, because the adjacent text already names the app.
 */
export function BrandMark({
  size = 34,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  const stroke = Math.max(1.4, size * 0.075);
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-accent/30 brand-gradient shadow-glow ${className}`}
      style={{ width: size, height: size }}
    >
      {/* The gradient tile is the frame; this inner pane darkens it so the
          waveform reads as a lit instrument, not a solid sticker. */}
      <span
        className="absolute inset-0"
        style={{ background: 'color-mix(in srgb, var(--color-bg) 74%, transparent)' }}
      />
      <svg
        viewBox="0 0 24 24"
        width={size * 0.64}
        height={size * 0.64}
        fill="none"
        className="relative text-accent"
      >
        <path
          d="M2 12h4l2.2-6.4 3.2 13 2.6-9.2 1.8 2.6H22"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
