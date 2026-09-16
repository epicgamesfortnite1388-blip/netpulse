import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Globe from 'react-globe.gl';
import * as THREE from 'three';

import { worldLandRings } from '@netpulse/shared';

import { arcTooltipHtml, nodePointColor, nodePointRadius, nodeTooltipHtml, zoomProxyFromAltitude } from './globeMath';

import type { GlobeMethods } from 'react-globe.gl';
import type { GlobeArc, GlobeNode, GlobeRoute } from './mapEncoding';

/**
 * The globe renderer — react-globe.gl (the library behind most network
 * globes you've seen). Hover picking, click picking, HTML tooltips, camera
 * orbit/zoom and the selected-pin pulse are the library's proven paths, so
 * "hover shows nothing" and "clicks miss" are structurally impossible
 * instead of perpetually re-patched. Geography stays ours: real Natural
 * Earth rings drawn as hex-tiled land, offline, no tile server.
 *
 * The prop contract (nodes / arcs / route / focus / onSelect / onHover /
 * onZoomChange) is unchanged from the previous implementation.
 */

const DARK_BG = 'rgba(7, 13, 23, 1)';
const LAND_COLOR = '#2c4a6e';
const ROUTE_COLOR = '#22d3ee';
const IDLE_POV = { lat: 22, lng: 10, altitude: 1.9 };
const FOCUS_ALTITUDE = 1.2;
const FOCUS_MS = 900;

export interface GlobeCanvasProps {
  nodes: GlobeNode[];
  arcs: GlobeArc[];
  /** Measured hop-by-hop route for the selected observation (if any). */
  route: GlobeRoute | null;
  /** Geographic point the camera should look at (lat/lon), when set. */
  focus?: { lat: number; lon: number } | null;
  /** Change focus only when this key changes (prevents re-aim on every update). */
  focusKey?: string | null;
  privacy?: boolean;
  reducedMotion?: boolean;
  onSelect?: (node: GlobeNode | null) => void;
  onHover?: (node: GlobeNode | null) => void;
  /** Reports a zoom proxy (higher = closer) so the page can cluster by camera distance. */
  onZoomChange?: (zoom: number) => void;
}

/** Natural Earth rings → GeoJSON polygon features for globe.gl's hex-land. */
interface LandFeature {
  type: 'Feature';
  properties: Record<string, never>;
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
}

function buildLandFeatures(): LandFeature[] {
  const out: LandFeature[] = [];
  for (const ring of worldLandRings()) {
    if (ring.length < 3) continue;
    const coords = ring.map((p) => [p[0], p[1]] as [number, number]);
    const first = coords[0]!;
    const last = coords[coords.length - 1]!;
    // polygons must be closed rings
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);
    out.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } });
  }
  return out;
}

/** Ocean sphere material: offline canvas texture with a subtle graticule. */
function buildGlobeMaterial(): THREE.MeshBasicMaterial {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#0a1524');
  grad.addColorStop(0.5, '#0b1b30');
  grad.addColorStop(1, '#0a1524');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(76, 116, 158, 0.16)';
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 15) {
    const x = ((lon + 180) / 360) * canvas.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: texture });
}

export function GlobeCanvas({ nodes, arcs, route, focus, focusKey, reducedMotion, onSelect, onHover, onZoomChange }: GlobeCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  //
  // Explicit size: react-globe.gl auto-sizes to its parent ONLY when the
  // parent reports a measurable size at mount. Inside the card grid the
  // container measures 0 at mount and the library silently falls back to
  // window size — the canvas then spills across the whole page, covering
  // sibling panels (clicks "on pins" landed on the Targets card). Measure
  // the container and pass width/height explicitly.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize((prev) => (prev?.w === w && prev?.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  const onZoomRef = useRef(onZoomChange);
  onSelectRef.current = onSelect;
  onHoverRef.current = onHover;
  onZoomRef.current = onZoomChange;
  const reducedRef = useRef(!!reducedMotion);
  reducedRef.current = !!reducedMotion;

  const globeMaterial = useMemo(buildGlobeMaterial, []);
  useEffect(() => () => {
    globeMaterial.map?.dispose();
    globeMaterial.dispose();
  }, [globeMaterial]);

  const landFeatures = useMemo(buildLandFeatures, []);

  /**
   * Hover emphasis without layer churn: scale the hovered marker's mesh in
   * the scene directly (globe.gl object helpers) instead of feeding hover
   * state back through props — the latter rebuilt every point mesh per
   * pointer move and killed the tooltip mid-hover.
   */
  const handlePointHover = useCallback((obj: object | null) => {
    const node = (obj ?? null) as GlobeNode | null;
    const g = globeRef.current;
    const controls = g?.controls();
    if (controls) controls.autoRotate = !reducedRef.current && node == null;
    if (containerRef.current) containerRef.current.dataset['hovered'] = node?.id ?? '';
    onHoverRef.current?.(node);
  }, []);

  const handlePointClick = useCallback((obj: object) => {
    const node = obj as GlobeNode;
    // Cluster pins expand by zooming the CAMERA toward the cluster — the
    // camera altitude is the single source of truth for clustering (it feeds
    // back via onZoomChange), so a state counter here would be overwritten
    // by the next camera event and the cluster would never break apart.
    if (node.cluster != null) {
      const g = globeRef.current;
      if (g) {
        const cur = g.pointOfView();
        g.pointOfView({ lat: node.lat, lng: node.lon, altitude: Math.max(0.35, cur.altitude * 0.55) }, reducedRef.current ? 0 : 700);
      }
      return;
    }
    onSelectRef.current?.(node);
  }, []);

  const handleGlobeReady = useCallback(() => {
    const g = globeRef.current;
    if (!g) return;
    // Automation hook (same pattern globe.gl examples use): tests/CDP read
    // exact pin screen positions instead of sweeping blind.
    if (containerRef.current) (containerRef.current as unknown as { __globe?: GlobeMethods }).__globe = g;
    const r = g.getGlobeRadius();
    const controls = g.controls();
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = r * 1.35;
    controls.maxDistance = r * 6;
    controls.autoRotateSpeed = 0.28;
    controls.autoRotate = !reducedRef.current;
    g.pointOfView(IDLE_POV, 0);
  }, []);

  // Reduced motion: stop the idle spin entirely.
  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (controls) controls.autoRotate = !reducedMotion;
  }, [reducedMotion]);

  // Keep the automation hook's pin list current (the ref exposes
  // getScreenCoords but not pointsData, so tests read the nodes from here).
  useEffect(() => {
    if (containerRef.current) (containerRef.current as unknown as { __globeNodes?: GlobeNode[] }).__globeNodes = nodes;
  }, [nodes]);

  // Focus fly-to — only when the focus key changes (not on every update).
  useEffect(() => {
    if (!focus || !focusKey) return;
    globeRef.current?.pointOfView({ lat: focus.lat, lng: focus.lon, altitude: FOCUS_ALTITUDE }, reducedRef.current ? 0 : FOCUS_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // Automation/test hook: how many pins the globe holds right now.
  useEffect(() => {
    if (containerRef.current) containerRef.current.dataset['pins'] = String(nodes.length);
  }, [nodes]);

  /** Zoom proxy for upstream clustering (same scale as the old canvas). */
  const handleZoom = useCallback((pov: { altitude?: number }) => {
    onZoomRef.current?.(zoomProxyFromAltitude(pov.altitude ?? 1.9));
  }, []);

  const pointsData = useMemo(() => nodes, [nodes]);

  const arcsData = useMemo(
    () => arcs.map((a) => ({ ...a, kind: a.kind as 'normal' | 'vpn' | 'historical' })),
    [arcs],
  );

  /** The selected pin gets the library's animated surface ring. */
  const ringsData = useMemo(() => {
    const sel = nodes.find((n) => n.selected);
    return sel && !reducedMotion ? [{ lat: sel.lat, lng: sel.lon }] : [];
  }, [nodes, reducedMotion]);
  /** Measured traceroute as a distinct animated path (never an invented line). */
  const pathsData = useMemo(() => {
    if (!route || route.hops.length < 2) return [];
    return [{ id: route.id, points: route.hops.map((h) => [h.lat, h.lon] as [number, number]) }];
  }, [route]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" data-testid="globe-canvas">
      {size && (
        <Globe
          width={size.w}
          height={size.h}
        ref={globeRef}
        onGlobeReady={handleGlobeReady}
        backgroundColor={DARK_BG}
        showAtmosphere
        atmosphereColor="#3a7ca8"
        atmosphereAltitude={0.16}
        globeMaterial={globeMaterial}
        hexPolygonsData={landFeatures}
        hexPolygonResolution={3}
        hexPolygonMargin={0.22}
        hexPolygonColor={() => LAND_COLOR}
        hexPolygonsTransitionDuration={0}
        hexPolygonLabel={() => ''}
        pointsData={pointsData}
        pointLat={(d: object) => (d as GlobeNode).lat}
        pointLng={(d: object) => (d as GlobeNode).lon}
        pointColor={(d: object) => nodePointColor(d as GlobeNode)}
        pointRadius={(d: object) => nodePointRadius(d as GlobeNode)}
        pointAltitude={0.008}
        pointLabel={(d: object) => nodeTooltipHtml(d as GlobeNode)}
        pointsMerge={false}
        pointsTransitionDuration={reducedMotion ? 0 : 250}
        onPointHover={handlePointHover}
        onPointClick={handlePointClick}
        arcsData={arcsData}
        arcStartLat={(d: object) => (d as GlobeArc).from.lat}
        arcStartLng={(d: object) => (d as GlobeArc).from.lon}
        arcEndLat={(d: object) => (d as GlobeArc).to.lat}
        arcEndLng={(d: object) => (d as GlobeArc).to.lon}
        arcColor={(d: object) => [arcColorOf(d as GlobeArc)]}
        arcStroke={(d: object) => ((d as GlobeArc).selected ? 1.6 : 0.9)}
        arcAltitudeAutoScale={0.4}
        arcLabel={(d: object) => arcTooltipHtml(d as GlobeArc)}
        arcsTransitionDuration={0}
        pathsData={pathsData}
        pathPoints="points"
        pathPointLat={(p: object) => (p as [number, number])[0]}
        pathPointLng={(p: object) => (p as [number, number])[1]}
        pathColor={() => ROUTE_COLOR}
        pathStroke={2.2}
        pathDashLength={reducedMotion ? undefined : 0.06}
        pathDashGap={0.018}
        pathDashAnimateTime={reducedMotion ? 0 : 9000}
        pathLabel={() => 'Measured traceroute — real hop-by-hop path (geo-evidenced hops only)'}
        pathTransitionDuration={0}
        ringsData={ringsData}
        ringLat={(d: object) => (d as { lat: number }).lat}
        ringLng={(d: object) => (d as { lat: number; lng: number }).lng}
        ringColor={() => ['rgba(34,211,238,0.85)', 'rgba(34,211,238,0)']}
        ringMaxRadius={4}
        ringPropagationSpeed={2.4}
        ringRepeatPeriod={700}
        ringResolution={64}
        ringAltitude={0.001}
        onZoom={handleZoom}
        />
      )}
    </div>
  );
}

function arcColorOf(arc: GlobeArc): string {
  if (arc.kind === 'vpn') return '#fbbf24';
  if (arc.kind === 'historical') return '#94a3b8';
  if (arc.latencyMs == null) return '#64748b';
  if (arc.latencyMs < 60) return '#34d399';
  if (arc.latencyMs < 120) return '#22d3ee';
  if (arc.latencyMs < 220) return '#fbbf24';
  return '#f87171';
}
