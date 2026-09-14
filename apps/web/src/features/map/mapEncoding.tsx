import type { GeoConfidenceLevel } from '@netpulse/shared';

/**
 * Visual encoding shared by every map surface (globe pins, SVG glyphs,
 * filters, legend copy). The canvas draws from these tables — never a
 * hand-rolled copy that can drift from what the map actually shows.
 */

/* ------------------------------- globe data ------------------------------- */

/** A marker on the globe. `cluster` set = aggregated cluster node. */
export interface GlobeNode {
  id: string;
  label: string;
  sub?: string | null;
  lat: number;
  lon: number;
  kind: 'you' | 'target' | 'vpn' | 'hop' | 'known';
  status: 'excellent' | 'good' | 'fair' | 'poor' | 'unreachable' | 'unknown';
  latencyMs: number | null;
  geoConfidence?: 'high' | 'medium' | 'low' | 'unknown';
  historical?: boolean;
  selected?: boolean;
  /** Set when this marker aggregates N collapsed nodes (clustering). */
  cluster?: number;
}

/** Approximate endpoint-to-endpoint connection (great-circle arc). */
export interface GlobeArc {
  id: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  kind: 'normal' | 'vpn' | 'historical';
  latencyMs: number | null;
  lossPct: number | null;
  selected?: boolean;
}

/** A MEASURED hop-by-hop route (traceroute) — distinct from GlobeArc. */
export interface GlobeRoute {
  id: string;
  /** Real measured hops that carry geo evidence (refused hops stay out). */
  hops: { lat: number; lon: number; label?: string }[];
  historical?: boolean;
}

/**
 * Marker color semantics: kind first, then measured status.
 */
export const GLOBE_KIND_COLOR: Record<GlobeNode['kind'], string> = {
  you: '#a78bfa',
  target: '#22d3ee',
  vpn: '#fbbf24',
  hop: '#94a3b8',
  known: '#22d3ee',
};

/** Minimum pin trust shown on the map. 'show all' disables filtering. */
export type ConfidenceThreshold = 'show all' | GeoConfidenceLevel;

/** Strictly ordered trust levels, lowest first — the filter hierarchy. */
export const CONFIDENCE_ORDER: readonly GeoConfidenceLevel[] = ['unknown', 'low', 'medium', 'high'];

/**
 * True when a pin's confidence meets the user's minimum-trust threshold.
 * Unlocated pins (no confidence) are always shown — the filter hides pins
 * whose PLACE is shaky, not pins that honestly have no place at all.
 * 'show all' passes everything.
 */
export function confidenceMeetsThreshold(confidence: GeoConfidenceLevel | undefined, min: ConfidenceThreshold): boolean {
  if (min === 'show all') return true;
  if (confidence == null) return true;
  return CONFIDENCE_ORDER.indexOf(confidence) >= CONFIDENCE_ORDER.indexOf(min);
}

/**
 * Confidence ring styles: solid = measured fact, dashed = estimate, faint
 * dashes = rough guess, ghost = placement evidence unknown. The ring is
 * drawn just outside the pin (radiusFactor × marker radius); alpha is the
 * ring opacity. Strictly ordered: higher confidence = more solid + brighter.
 */
export const CONFIDENCE_RING: Record<NonNullable<GeoConfidenceLevel>, { radiusFactor: number; dash: number[]; alpha: number }> = {
  high: { radiusFactor: 1.9, dash: [], alpha: 0.85 },
  medium: { radiusFactor: 1.9, dash: [3, 3], alpha: 0.7 },
  low: { radiusFactor: 2.3, dash: [2, 4], alpha: 0.45 },
  unknown: { radiusFactor: 2.3, dash: [1, 5], alpha: 0.3 },
};

/**
 * Legend copy for the confidence rings — one entry per ring style, shared by
 * the map's corner legend and the destination panel's Location-row tooltip so
 * the words can never drift from what the rings actually draw.
 */
export const CONFIDENCE_LEGEND: Record<NonNullable<GeoConfidenceLevel>, { ring: string; meaning: string }> = {
  high: { ring: '◎ solid ring', meaning: 'Known endpoint — the place itself reports where it is (e.g. a Cloudflare colo).' },
  medium: { ring: '◌ dashed ring', meaning: 'GeoIP estimate of the resolved IP — city-level, approximate.' },
  low: { ring: '﹒ sparse ring', meaning: 'Country-level GeoIP guess — coarse, city unknown.' },
  unknown: { ring: '﹒ faintest ring', meaning: 'Location evidence is minimal — treat the pin as indicative only.' },
};

/**
 * The ring-legend tooltip body. Rendered above the map's corner legend and
 * next to the destination panel's confidence glyph, so hovering either
 * surface explains every ring style the same way.
 */
export function ConfidenceLegendBody() {
  return (
    <div className="space-y-1.5">
      <div className="font-semibold text-text">Ring = how well the location is known</div>
      {(Object.keys(CONFIDENCE_LEGEND) as (keyof typeof CONFIDENCE_LEGEND)[]).map((level) => (
        <div key={level} className="flex gap-2">
          <span className="w-24 shrink-0 text-accent">{CONFIDENCE_LEGEND[level].ring}</span>
          <span className="text-muted">{CONFIDENCE_LEGEND[level].meaning}</span>
        </div>
      ))}
      <div className="pt-0.5 text-faint">Node positions are known endpoints or GeoIP estimates — never exact router locations.</div>
    </div>
  );
}

/**
 * Panel-side ring style derived from CONFIDENCE_RING — the destination
 * panel's Location row shows the same glyph encoding as the pins, so the
 * two can never drift apart.
 */
export function ringGlyphStyle(level: NonNullable<GeoConfidenceLevel>): { dashArray?: string; opacity: number } {
  const ring = CONFIDENCE_RING[level];
  return { dashArray: ring.dash.length > 0 ? ring.dash.join(' ') : undefined, opacity: ring.alpha };
}

/**
 * Selected-pin ripple: one expanding, fading ring per ~1.6 s cycle that
 * grows out of the confidence ring to draw the eye. Pure so the geometry
 * is testable; `t` is the phase in [0,1).
 */
export function ringPulse(baseRadiusFactor: number, t: number): { radiusFactor: number; alpha: number } {
  const phase = t - Math.floor(t); // wrap
  return {
    radiusFactor: baseRadiusFactor + phase * 0.9,
    alpha: 0.5 * (1 - phase) ** 1.5,
  };
}

/** Inline SVG ring matching the map pin encoding for one confidence level. */
export function ConfidenceRingGlyph({ level, size = 11 }: { level: NonNullable<GeoConfidenceLevel>; size?: number }) {
  const { dashArray, opacity } = ringGlyphStyle(level);
  const r = size / 2 - 1;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="inline-block shrink-0 align-[-1px]" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeDasharray={dashArray}
        opacity={opacity}
      />
    </svg>
  );
}
