import { useEffect, useRef } from 'react';

import { worldLandRings } from '@netpulse/shared';

import type { GeoConfidenceLevel } from '@netpulse/shared';

/* ------------------------------ data model -------------------------------- */

export interface MapNode {
  id: string;
  label: string;
  sub?: string | null;
  lat: number;
  lon: number;
  kind: 'you' | 'target' | 'vpn' | 'hop' | 'known';
  status: 'excellent' | 'good' | 'fair' | 'poor' | 'unreachable' | 'unknown';
  latencyMs: number | null;
  /** How well this pin's location is actually known (drives the ring style). */
  geoConfidence?: 'high' | 'medium' | 'low' | 'unknown';
  historical?: boolean;
  selected?: boolean;
}

export interface MapArc {
  id: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  kind: 'normal' | 'vpn' | 'historical';
  latencyMs: number | null;
  lossPct: number | null;
  selected?: boolean;
}

export interface MapPath {
  id: string;
  points: { lat: number; lon: number }[];
  label: string;
  historical?: boolean;
}

/* ------------------------------- colors ----------------------------------- */

const STATUS_COLOR: Record<MapNode['status'], string> = {
  excellent: '#34d399',
  good: '#22d3ee',
  fair: '#fbbf24',
  poor: '#f87171',
  unreachable: '#f87171',
  unknown: '#64748b',
};

const KIND_COLOR: Record<MapNode['kind'], string> = {
  you: '#a78bfa',
  target: '#22d3ee',
  vpn: '#fbbf24',
  hop: '#94a3b8',
  known: '#22d3ee',
};

const ARC_COLOR: Record<MapArc['kind'], string> = {
  normal: 'rgba(34,211,238,0.75)',
  vpn: 'rgba(251,191,36,0.85)',
  historical: 'rgba(148,163,184,0.55)',
};

/** Confidence ring styles: solid = measured fact, dashed = estimate, faint
 *  dashes = rough guess. The ring is drawn just outside the pin. */
export const CONFIDENCE_RING: Record<NonNullable<MapNode['geoConfidence']>, { radiusFactor: number; dash: number[]; alpha: number }> = {
  high: { radiusFactor: 1.9, dash: [], alpha: 0.85 },
  medium: { radiusFactor: 1.9, dash: [3, 3], alpha: 0.7 },
  low: { radiusFactor: 2.3, dash: [2, 4], alpha: 0.45 },
  unknown: { radiusFactor: 2.3, dash: [1, 5], alpha: 0.3 },
};

/** Minimum pin trust shown on the map. 'show all' disables filtering. */
export type ConfidenceThreshold = 'show all' | GeoConfidenceLevel;

/**
 * Panel-side ring style derived from CONFIDENCE_RING — the destination
 * panel's Location row shows the same glyph encoding as the pins, so the
 * two can never drift apart.
 */
export function ringGlyphStyle(level: NonNullable<MapNode['geoConfidence']>): { dashArray?: string; opacity: number } {
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

/** Inline SVG ring matching the canvas pin encoding for one confidence level. */
export function ConfidenceRingGlyph({ level, size = 11 }: { level: NonNullable<MapNode['geoConfidence']>; size?: number }) {
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

/** Strictly ordered trust levels, lowest first — the filter hierarchy. */
const CONFIDENCE_ORDER: readonly GeoConfidenceLevel[] = ['unknown', 'low', 'medium', 'high'];

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

interface Camera {
  cx: number; // center longitude
  cy: number; // center latitude
  zoom: number; // px per degree of longitude
}

interface Props {
  nodes: MapNode[];
  arcs: MapArc[];
  paths: MapPath[];
  /** focus camera on a location (changes trigger a smooth move) */
  focus?: { lat: number; lon: number } | null;
  focusKey?: string | null;
  privacy?: boolean;
  reducedMotion?: boolean;
  onSelect?: (node: MapNode | null) => void;
  onHover?: (node: MapNode | null) => void;
}

const MIN_ZOOM = 1.1;
const MAX_ZOOM = 24;

/** World land polygons decoded once per module — real Natural Earth geography. */
const LAND = worldLandRings();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function MapCanvas({ nodes, arcs, paths, focus, focusKey, privacy, reducedMotion, onSelect, onHover }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<Camera>({ cx: 30, cy: 32, zoom: 3.2 });
  const camTargetRef = useRef<Camera>({ cx: 30, cy: 32, zoom: 3.2 });
  const nodesRef = useRef(nodes);
  const arcsRef = useRef(arcs);
  const pathsRef = useRef(paths);
  const hoverRef = useRef<MapNode | null>(null);
  const dragRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const focusKeyRef = useRef<string | null>(null);
  const reducedRef = useRef(reducedMotion ?? false);
  const privacyRef = useRef(privacy ?? false);
  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  const pulseSeedRef = useRef(Math.random() * 100);

  nodesRef.current = nodes;
  arcsRef.current = arcs;
  pathsRef.current = paths;
  reducedRef.current = reducedMotion ?? false;
  privacyRef.current = privacy ?? false;
  onSelectRef.current = onSelect;
  onHoverRef.current = onHover;

  // smooth camera moves toward focus
  useEffect(() => {
    if (focus) {
      camTargetRef.current = { ...camTargetRef.current, cx: focus.lon, cy: focus.lat };
    }
    if (focusKey && focusKey !== focusKeyRef.current) {
      focusKeyRef.current = focusKey;
      camTargetRef.current = { ...camTargetRef.current, zoom: Math.max(camTargetRef.current.zoom, 4.5) };
    }
  }, [focus, focusKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const project = (lat: number, lon: number): { x: number; y: number } => {
      const cam = camRef.current;
      // wrap longitude so panning across the date line stays continuous
      let dLon = lon - cam.cx;
      while (dLon > 180) dLon -= 360;
      while (dLon < -180) dLon += 360;
      return {
        x: width / 2 + dLon * cam.zoom,
        y: height / 2 - (lat - cam.cy) * cam.zoom,
      };
    };

    const toLonLat = (x: number, y: number): { lat: number; lon: number } => {
      const cam = camRef.current;
      return { lon: cam.cx + (x - width / 2) / cam.zoom, lat: cam.cy - (y - height / 2) / cam.zoom };
    };

    const drawBackground = () => {
      const g = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.75);
      g.addColorStop(0, '#0a1220');
      g.addColorStop(1, '#060a12');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);

      // Real world map: Natural Earth land polygons in the same equirectangular
      // projection as the node positions — continents line up exactly with
      // measured nodes. Land is a dark slate fill with a faint coastline stroke.
      const cam = camRef.current;
      const lonMin = cam.cx - width / (2 * cam.zoom) - 4;
      const lonMax = cam.cx + width / (2 * cam.zoom) + 4;
      const latMin = cam.cy - height / (2 * cam.zoom) - 4;
      const latMax = cam.cy + height / (2 * cam.zoom) + 4;

      const ringVisible = (ring: [number, number][]) => {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (const [lon, lat] of ring) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
        if (maxLat < latMin || minLat > latMax) return false;
        // wrap-aware longitude overlap
        if (maxLon - minLon >= 360) return true;
        let lo = minLon, hi = maxLon;
        while (lo > lonMax) { lo -= 360; hi -= 360; }
        while (hi < lonMin) { lo += 360; hi += 360; }
        return hi >= lonMin && lo <= lonMax;
      };

      // land fill
      ctx.fillStyle = 'rgba(51,65,85,0.55)';
      ctx.beginPath();
      for (const ring of LAND) {
        if (!ringVisible(ring)) continue;
        let started = false;
        for (const [lon, lat] of ring) {
          const p = project(lat, lon);
          if (!started) { ctx.moveTo(p.x, p.y); started = true; }
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');

      // coastline stroke
      ctx.strokeStyle = 'rgba(148,163,184,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const ring of LAND) {
        if (!ringVisible(ring)) continue;
        let started = false;
        for (const [lon, lat] of ring) {
          const p = project(lat, lon);
          if (!started) { ctx.moveTo(p.x, p.y); started = true; }
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.stroke();
    };

    const drawGraticule = () => {
      ctx.strokeStyle = 'rgba(100,116,139,0.10)';
      ctx.lineWidth = 1;
      const cam = camRef.current;
      const lonStep = cam.zoom < 2 ? 30 : cam.zoom < 5 ? 15 : 5;
      const latStep = cam.zoom < 2 ? 30 : cam.zoom < 5 ? 15 : 5;
      ctx.beginPath();
      for (let lon = -180; lon <= 180; lon += lonStep) {
        const p = project(0, lon);
        if (p.x < -20 || p.x > width + 20) continue;
        ctx.moveTo(p.x, 0);
        ctx.lineTo(p.x, height);
      }
      for (let lat = -90; lat <= 90; lat += latStep) {
        const p = project(lat, 0);
        if (p.y < -20 || p.y > height + 20) continue;
        ctx.moveTo(0, p.y);
        ctx.lineTo(width, p.y);
      }
      ctx.stroke();
    };

    const drawPath = (path: MapPath) => {
      const pts = path.points.map((p) => project(p.lat, p.lon)).filter((p) => p.x > -40 && p.x < width + 40 && p.y > -40 && p.y < height + 40);
      if (pts.length < 2) return;
      ctx.strokeStyle = path.historical ? 'rgba(148,163,184,0.4)' : 'rgba(34,211,238,0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash(path.historical ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    const drawArc = (arc: MapArc, timeMs: number) => {
      const a = project(arc.from.lat, arc.from.lon);
      const b = project(arc.to.lat, arc.to.lon);
      if ((a.x < -60 || a.x > width + 60 || a.y < -60 || a.y > height + 60) && (b.x < -60 || b.x > width + 60 || b.y < -60 || b.y > height + 60)) return;
      // quadratic control point lifted perpendicular to the chord
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const lift = Math.min(90, dist * 0.22);
      const cx = mx - (dy / dist) * lift;
      const cy = my + (dx / dist) * lift;

      const color = ARC_COLOR[arc.kind];
      const selected = arc.selected;
      ctx.strokeStyle = selected ? color : color.replace(/[\d.]+\)$/, '0.35)');
      ctx.lineWidth = selected ? 2.2 : 1.2;
      ctx.shadowColor = selected ? 'rgba(34,211,238,0.5)' : 'transparent';
      ctx.shadowBlur = selected ? 8 : 0;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // latency-colored pulse dots (visualization only — speed approximates RTT)
      if (reducedRef.current) return;
      const latency = arc.latencyMs;
      const speed = latency != null && latency > 0 ? clamp(0.9 + 90 / latency, 1, 2.6) : 1.4;
      const count = Math.max(2, Math.min(5, Math.round(dist / 90)));
      const seed = pulseSeedRef.current;
      for (let i = 0; i < count; i++) {
        const t = ((timeMs / 1000) * speed + seed + i / count) % 1;
        const inv = 1 - t;
        const px = inv * inv * a.x + 2 * inv * t * cx + t * t * b.x;
        const py = inv * inv * a.y + 2 * inv * t * cy + t * t * b.y;
        // occasional dropped pulse when loss is observed
        if (arc.lossPct != null && arc.lossPct > 0 && Math.sin(t * 41.3 + i * 7.7) * 100 < arc.lossPct * 2) continue;
        const fade = Math.sin(Math.PI * t);
        ctx.beginPath();
        ctx.arc(px, py, 1.6 + fade * 1.6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.25 + fade * 0.65;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };

    /**
     * Collision-aware label placement: labels of nearby nodes are pushed apart
     * so they never overlap, regardless of how many targets share a city.
     * Cheap greedy pass — labels are laid out in order and displaced
     * horizontally until they clear previously placed ones.
     */
    const placeLabels = (items: { node: MapNode; p: { x: number; y: number }; text: string; w: number }[]): { x: number; y: number }[] => {
      const placed: { x: number; y: number; w: number }[] = [];
      const anchorCount = new Map<string, number>(); // how many labels already sit at an identical anchor point
      return items.map((it) => {
        // nodes sharing the same screen point (same city) get vertically
        // stacked rows first, then horizontal slots when a row overflows
        const key = `${Math.round(it.p.x)},${Math.round(it.p.y)}`;
        const n = anchorCount.get(key) ?? 0;
        anchorCount.set(key, n + 1);
        const ty = it.p.y - 3 - n * 13;
        let tx = it.p.x + 8;
        // find a horizontal slot that doesn't overlap any placed label
        for (;;) {
          const clash = placed.some((l) => Math.abs(l.y - ty) < 12 && tx < l.x + l.w + 6 && tx + it.w + 6 > l.x);
          if (!clash) break;
          tx += it.w + 12;
        }
        placed.push({ x: tx, y: ty, w: it.w });
        return { x: tx, y: ty };
      });
    };

    const drawNode = (node: MapNode, timeMs: number, isHover: boolean, at?: { x: number; y: number }) => {
      const p = at ?? project(node.lat, node.lon);
      if (p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 30) return;
      const color = node.kind === 'you' ? KIND_COLOR.you : node.status === 'unknown' ? KIND_COLOR[node.kind] : STATUS_COLOR[node.status];
      // zoom-scaled markers: shrink at far zoom so clusters stop smearing
      const zoomScale = clamp(camRef.current.zoom / 3.2, 0.6, 1.6);
      const r = (node.kind === 'you' ? 5 : node.kind === 'hop' ? 2.6 : 4) * zoomScale;
      const pulse = node.kind === 'you' || node.selected ? (0.5 + 0.5 * Math.sin(timeMs / 700 + node.lat)) * 0.5 : 0;

      if (node.kind === 'you' || node.selected || isHover) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 6 + pulse * 5, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,15,26,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();

      if (node.kind === 'you') {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }

      // Geo-confidence ring: solid = known endpoint (high), dashed = GeoIP
      // estimate (medium), faint sparse dashes = rough guess (low), ghost ring
      // = placement evidence unknown. Skipped for 'you' — it's the user.
      if (node.geoConfidence && node.geoConfidence !== 'unknown' && node.kind !== 'you') {
        const ring = CONFIDENCE_RING[node.geoConfidence];
        // Selected pins ripple: an expanding fading ring seeded from the
        // confidence ring's radius, cycling ~1.6 s. Reduced-motion users get
        // a steady double-thick confidence ring instead — emphasis without
        // animation.
        if (node.selected && !reducedRef.current) {
          const pulse = ringPulse(ring.radiusFactor, timeMs / 1600);
          ctx.beginPath();
          ctx.setLineDash([]);
          ctx.arc(p.x, p.y, r * pulse.radiusFactor, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.globalAlpha = pulse.alpha;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.setLineDash(ring.dash);
        ctx.arc(p.x, p.y, r * ring.radiusFactor, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = node.selected ? Math.min(1, ring.alpha + 0.25) : ring.alpha;
        ctx.lineWidth = node.selected ? 2 : 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    };

    /** Draw all node labels with collision avoidance (prevent stacking). */
    const drawLabels = () => {
      const showAll = camRef.current.zoom >= 4.5;
      const items: { node: MapNode; p: { x: number; y: number }; text: string; w: number }[] = [];
      for (const node of nodesRef.current) {
        const p = project(node.lat, node.lon);
        if (p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 30) continue;
        const visible = node.selected || hoverRef.current?.id === node.id || node.kind === 'you' || node.kind === 'vpn' || showAll;
        if (!visible || !node.label) continue;
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        items.push({ node, p, text: node.label, w: ctx.measureText(node.label).width + 8 });
      }
      const slots = placeLabels(items);
      items.forEach((it, i) => {
        const slot = slots[i]!;
        const color = it.node.kind === 'you' ? KIND_COLOR.you : it.node.status === 'unknown' ? KIND_COLOR[it.node.kind] : STATUS_COLOR[it.node.status];
        ctx.fillStyle = 'rgba(8,15,26,0.78)';
        ctx.fillRect(slot.x - 2, slot.y - 9, it.w + 8, 13);
        ctx.fillStyle = color;
        ctx.fillText(it.text, slot.x, slot.y + 1);
        if (it.node.latencyMs != null && !privacyRef.current) {
          ctx.font = '600 10px ui-monospace, Menlo, monospace';
          ctx.fillStyle = 'rgba(226,232,240,0.85)';
          ctx.fillText(`${Math.round(it.node.latencyMs)} ms`, slot.x, slot.y + 12);
        }
      });
    };

    const hitTest = (x: number, y: number): MapNode | null => {
      let best: MapNode | null = null;
      let bestDist = 14;
      for (const node of nodesRef.current) {
        const p = project(node.lat, node.lon);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestDist) {
          bestDist = d;
          best = node;
        }
      }
      return best;
    };

    const frame = (timeMs: number) => {
      if (document.hidden) {
        raf = requestAnimationFrame(frame);
        return;
      }
      // smooth camera
      const cam = camRef.current;
      const target = camTargetRef.current;
      const k = 0.12;
      cam.cx += (target.cx - cam.cx) * k;
      cam.cy += (target.cy - cam.cy) * k;
      cam.zoom += (target.zoom - cam.zoom) * k;
      if (Math.abs(target.zoom - cam.zoom) < 0.01) cam.zoom = target.zoom;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBackground();
      drawGraticule();
      for (const path of pathsRef.current) drawPath(path);
      for (const arc of arcsRef.current) drawArc(arc, timeMs);
      // Collision spreading: markers landing on (nearly) the same pixel fan
      // out deterministically around the true point, ordered by id so the
      // layout is stable frame-to-frame. Arcs still anchor to the real
      // coordinates — only the marker is offset, never the data.
      const spread = new Map<string, { x: number; y: number }>();
      {
        const groups = new Map<string, MapNode[]>();
        for (const node of nodesRef.current) {
          const p = project(node.lat, node.lon);
          const key = `${Math.round(p.x / 10)}:${Math.round(p.y / 10)}`;
          const list = groups.get(key) ?? [];
          list.push(node);
          groups.set(key, list);
        }
        for (const list of groups.values()) {
          if (list.length === 1) {
            const p = project(list[0]!.lat, list[0]!.lon);
            spread.set(list[0]!.id, p);
          } else {
            const center = project(list[0]!.lat, list[0]!.lon);
            const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
            const ringR = 4 + sorted.length * 2.2;
            sorted.forEach((node, i) => {
              const a = (2 * Math.PI * i) / sorted.length - Math.PI / 2;
              spread.set(node.id, { x: center.x + Math.cos(a) * ringR, y: center.y + Math.sin(a) * ringR });
            });
          }
        }
      }
      for (const node of nodesRef.current) drawNode(node, timeMs, hoverRef.current?.id === node.id, spread.get(node.id));
      drawLabels();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = toLonLat(mx, my);
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      const t = camTargetRef.current;
      t.zoom = clamp(t.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      // keep the point under the cursor fixed
      const after = toLonLat(mx, my);
      t.cx += before.lon - after.lon;
      t.cy += before.lat - after.lat;
    };

    const onPointerDown = (e: PointerEvent) => {
      const hit = hitTest(e.offsetX, e.offsetY);
      if (hit) {
        onSelectRef.current?.(hit);
        hoverRef.current = hit;
        onHoverRef.current?.(hit);
        return;
      }
      dragRef.current = { x: e.offsetX, y: e.offsetY, active: true };
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (dragRef.current.active) {
        const cam = camTargetRef.current;
        cam.cx -= (e.offsetX - dragRef.current.x) / cam.zoom;
        cam.cy += (e.offsetY - dragRef.current.y) / cam.zoom;
        dragRef.current.x = e.offsetX;
        dragRef.current.y = e.offsetY;
        return;
      }
      const hit = hitTest(e.offsetX, e.offsetY);
      if (hit?.id !== hoverRef.current?.id) {
        hoverRef.current = hit ?? null;
        onHoverRef.current?.(hit ?? null);
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      }
    };

    const onPointerUp = () => {
      dragRef.current.active = false;
    };

    const onPointerLeave = () => {
      hoverRef.current = null;
      onHoverRef.current?.(null);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="h-full w-full" style={{ cursor: 'grab' }} />;
}