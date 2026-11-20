/**
 * The NetPulse connection dial — the product's one signature visualization.
 *
 * It is NOT a decorative globe. Three concentric arcs each encode a real,
 * independently-reported backend signal:
 *
 *   outer  TUNNEL   a tunnel process/route exists
 *   middle TRAFFIC  a trace THROUGH the tunnel confirmed where traffic exits
 *   inner  GUARD    the fail-closed hold / kill switch is actually armed
 *
 * A tunnel that is up but unverified therefore shows a full outer ring and an
 * EMPTY middle ring: the visual literally cannot say "connected" when the
 * backend has not confirmed traffic. Rings change only when backend state
 * changes (a 280ms colour/arc transition), never in a loop — idle CPU cost is
 * zero, and reduced-motion preferences disable the transition entirely.
 */
import { TONE_VAR } from './connectionState';

import type { CSSProperties } from 'react';
import type { ConnectionPresentation } from './connectionState';

const RADII = { tunnel: 104, traffic: 86, guard: 68 } as const;

function Ring({
  r,
  fraction,
  color,
}: {
  r: number;
  fraction: number;
  color: string;
}) {
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <>
      <circle className="np-dial-track" cx="120" cy="120" r={r} />
      <circle
        className="np-dial-arc"
        cx="120"
        cy="120"
        r={r}
        pathLength={100}
        strokeDasharray={`${clamped * 100} 100`}
        stroke={color}
        opacity={clamped > 0 ? 1 : 0}
        transform="rotate(-90 120 120)"
      />
    </>
  );
}

export function ConnectionDial({ state, size = 236 }: { state: ConnectionPresentation; size?: number }) {
  const tunnelColor = TONE_VAR[state.tone];
  const trafficColor =
    state.dial.traffic >= 1 ? TONE_VAR.connected : state.dial.tunnel > 0 ? TONE_VAR.unverified : TONE_VAR.idle;
  const guardColor =
    state.dial.guard >= 1
      ? TONE_VAR.connected
      : state.dial.guard > 0
        ? TONE_VAR.unverified
        : TONE_VAR.idle;

  // Long labels need a smaller centre size to stay inside the innermost ring.
  const shortLabel = state.short;
  const fontSize = shortLabel.length > 13 ? 15 : shortLabel.length > 10 ? 17 : 20;

  return (
    <svg
      className="np-dial"
      width={size}
      height={size}
      viewBox="0 0 240 240"
      role="img"
      aria-label={`Connection state: ${state.label}. Tunnel ${Math.round(state.dial.tunnel * 100)} percent established, traffic ${Math.round(state.dial.traffic * 100)} percent verified, guard ${Math.round(state.dial.guard * 100)} percent armed.`}
    >
      {/* Hairline registration ticks make it read as an instrument face, not a
          progress spinner. They are static geometry, not an animation. */}
      {[0, 90, 180, 270].map((deg) => (
        <line
          key={deg}
          x1="120"
          y1="8"
          x2="120"
          y2="16"
          stroke="var(--color-line-strong)"
          strokeWidth="1"
          transform={`rotate(${deg} 120 120)`}
        />
      ))}
      <Ring r={RADII.tunnel} fraction={state.dial.tunnel} color={tunnelColor} />
      <Ring r={RADII.traffic} fraction={state.dial.traffic} color={trafficColor} />
      <Ring r={RADII.guard} fraction={state.dial.guard} color={guardColor} />

      <text className="np-dial-sub" x="120" y="92" textAnchor="middle">
        Connection
      </text>
      <text
        className="np-dial-center"
        x="120"
        y="126"
        textAnchor="middle"
        fontSize={fontSize}
        fill={tunnelColor}
      >
        {shortLabel}
      </text>
      <text className="np-dial-sub" x="120" y="146" textAnchor="middle">
        {state.exitIp ? `exit ${state.exitIp}` : state.dial.tunnel > 0 ? 'exit not verified' : 'direct path'}
      </text>

      {/* The pulse trace: one baseline, one spike. The brand mark, reduced to
          a single stroke inside the instrument face. */}
      <path
        d="M88 169h18l5-9 8 19 6-14 4 4h23"
        fill="none"
        stroke={tunnelColor}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
    </svg>
  );
}

/** The three-ring legend. Static text; each swatch uses the same token as its ring. */
export function DialLegend({ state }: { state: ConnectionPresentation }) {
  const rows = [
    {
      label: 'Tunnel',
      value: state.dial.tunnel >= 1 ? 'Established' : state.dial.tunnel > 0 ? 'In progress' : 'Not established',
      color: TONE_VAR[state.tone],
      fraction: state.dial.tunnel,
    },
    {
      label: 'Traffic',
      value: state.dial.traffic >= 1 ? 'Verified end to end' : state.dial.tunnel > 0 ? 'Not verified' : 'No tunnel',
      color: state.dial.traffic >= 1 ? TONE_VAR.connected : state.dial.tunnel > 0 ? TONE_VAR.unverified : TONE_VAR.idle,
      fraction: state.dial.traffic,
    },
    {
      label: 'Guard',
      value: state.dial.guard >= 1 ? 'Fail-closed armed' : state.dial.guard > 0 ? 'Partially armed' : 'Not armed',
      color: state.dial.guard >= 1 ? TONE_VAR.connected : state.dial.guard > 0 ? TONE_VAR.unverified : TONE_VAR.idle,
      fraction: state.dial.guard,
    },
  ];
  return (
    <ul className="space-y-0">
      {rows.map((row) => (
        <li key={row.label} className="np-row">
          <span className="flex items-center gap-2.5">
            <span className="np-state-dot" style={{ '--np-state': row.color } as CSSProperties} />
            <span className="np-label">{row.label}</span>
          </span>
          <span className="np-row-value">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}
