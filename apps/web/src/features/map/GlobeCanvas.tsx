import { useEffect, useMemo, useRef } from 'react';

import * as THREE from 'three';

import { worldLandRings } from '@netpulse/shared';

import { GLOBE_RADIUS, arcPoints, facesCamera, latencyColor, lonLatToVec3, nearestScreenPin, projectPins, thetaForLon } from './globeMath';
import { ringPulse } from './mapEncoding';

import type { Vec3 } from './globeMath';
import type { GlobeArc, GlobeNode, GlobeRoute } from './mapEncoding';

/* --------------------------------- scene ---------------------------------- */

const DARK_BG = '#070d17';
const MIN_DISTANCE = GLOBE_RADIUS * 1.35;
const MAX_DISTANCE = GLOBE_RADIUS * 6;
const BASE_MARKER = 0.11;

/**
 * Shared invisible pick-target material: visible=false is skipped by the
 * raycaster, so the hit spheres render nothing but still intercept rays —
 * color/opacity are irrelevant, one instance serves every marker.
 */
/**
 * Screen-space pick tolerance (CSS px). Markers are only a few pixels wide at
 * the default camera distance, so raycasting the marker spheres made hovers
 * and clicks miss almost every time (and the old invisible "hit sphere"
 * material was created with `visible: false`, which also hid it from the
 * renderer's picking path in some three.js builds). Picking is now done like
 * globe.gl: project every visible pin to screen space and take the nearest one
 * inside a fixed pixel radius — reliable at every zoom level.
 */
const PICK_TOLERANCE_PX = 14;

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

interface PreparedNode extends GlobeNode {
  pos: Vec3;
}

/** Vec3 → THREE.Vector3 (avoids struct-of-data coupling in the pure module). */
function v3(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, p.z);
}

/**
 * Build the land geometry: every Natural Earth ring becomes one closed
 * LineLoop on the sphere surface, slightly lifted to avoid z-fighting.
 * Thousands of segments total — cheap, and faithful to the real coastlines
 * already bundled for the map feature.
 */
function buildLandGroup(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({ color: 0x2c4a6e, transparent: true, opacity: 0.85 });
  for (const ring of worldLandRings()) {
    const pts = ring.map((p) => lonLatToVec3(p[0], p[1], GLOBE_RADIUS * 1.001));
    if (pts.length < 3) continue;
    const geometry = new THREE.BufferGeometry().setFromPoints(pts.map(v3));
    group.add(new THREE.LineLoop(geometry, material));
  }
  return group;
}

/**
 * Solid sphere with a subtle fresnel rim + graticule texture painted on a
 * canvas (no external asset needed; the real geography is the ring set).
 */
function buildGlobeMesh(): THREE.Mesh {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const ctx = canvas.getContext('2d')!;
  // deep ocean gradient
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#0a1524');
  grad.addColorStop(0.5, '#0b1b30');
  grad.addColorStop(1, '#0a1524');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // graticule every 15°
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

  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 96, 64);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  return mesh;
}

/** Atmosphere glow: back-side sphere with additive fresnel-ish material. */
function buildAtmosphere(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS * 1.06, 64, 48);
  const material = new THREE.MeshBasicMaterial({
    color: 0x1c4d7a,
    transparent: true,
    opacity: 0.16,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

export function GlobeCanvas({ nodes, arcs, route, focus, focusKey, privacy, reducedMotion, onSelect, onHover, onZoomChange }: GlobeCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const nodesGroupRef = useRef<THREE.Group>(null!);
  const arcsGroupRef = useRef<THREE.Group>(null!);
  const routeGroupRef = useRef<THREE.Group>(null!);
  /** Visible pins, in draw order — the candidates screen-space picking scans. */
  const pickablesRef = useRef<PreparedNode[]>([]);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const dataRef = useRef({ nodes: [] as PreparedNode[], arcs: [] as GlobeArc[], route: null as GlobeRoute | null });
  const animRef = useRef<number>(0);
  const camState = useRef({ theta: thetaForLon(10), phi: Math.PI / 2.4, dist: GLOBE_RADIUS * 2.6, targetTheta: thetaForLon(10), targetPhi: Math.PI / 2.4, targetDist: GLOBE_RADIUS * 2.6 });
  const reducedRef = useRef(!!reducedMotion);
  const privacyRef = useRef(!!privacy);
  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  const onZoomRef = useRef(onZoomChange);
  reducedRef.current = !!reducedMotion;
  privacyRef.current = !!privacy;
  onSelectRef.current = onSelect;
  onHoverRef.current = onHover;
  onZoomRef.current = onZoomChange;

  /* ------------------------- one-time scene bootstrap ---------------------- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(new THREE.Color(DARK_BG));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.add(buildGlobeMesh());
    scene.add(buildAtmosphere());
    scene.add(buildLandGroup());

    const nodesGroup = new THREE.Group();
    const arcsGroup = new THREE.Group();
    const routeGroup = new THREE.Group();
    scene.add(nodesGroup, arcsGroup, routeGroup);
    nodesGroupRef.current = nodesGroup;
    arcsGroupRef.current = arcsGroup;
    routeGroupRef.current = routeGroup;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    camera.position.set(0, 0, GLOBE_RADIUS * 2.6);
    cameraRef.current = camera;

    const ro = new ResizeObserver(() => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    /* ------------------------------- input -------------------------------- */
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let movedDistance = 0;

    const el = renderer.domElement;
    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      movedDistance = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      pointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        movedDistance += Math.abs(dx) + Math.abs(dy);
        const c = camState.current;
        // Grab-the-globe: the terrain under the pointer follows it. With the
        // thetaForLon convention, increasing theta moves the sub-camera point
        // westward, so a rightward drag needs targetTheta += dx.
        c.targetTheta += dx * 0.005;
        c.targetPhi = Math.max(0.12, Math.min(Math.PI - 0.12, c.targetPhi - dy * 0.005));
        lastX = e.clientX;
        lastY = e.clientY;
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      // click (not drag): pick
      if (movedDistance < 6) {
        const rect = el.getBoundingClientRect();
        pickAt(e.clientX - rect.left, e.clientY - rect.top);
      }
      el.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = camState.current;
      const factor = e.deltaY < 0 ? 0.88 : 1 / 0.88;
      c.targetDist = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, c.targetDist * factor));
    };
    const onLeave = () => {
      pointerRef.current = null;
      onHoverRef.current?.(null);
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerleave', onLeave);

    /* ------------------------------- picking ------------------------------- */
    // Screen-space picking (see PICK_TOLERANCE_PX): occlusion first, so a pin on
    // the far side of the globe can never eat a click or hover meant for the
    // near side, then nearest-to-pointer inside the pixel tolerance.
    function pickNearest(x: number, y: number): PreparedNode | null {
      const camera = cameraRef.current;
      const container = containerRef.current;
      if (!camera || !container) return null;
      const rect = container.getBoundingClientRect();
      const visible = pickablesRef.current.filter((n) => facesCamera(n.pos, camera.position));
      const projected = projectPins(visible, camera, rect.width, rect.height);
      // Machine-readable pick state for tests/automation: how many pins are
      // pickable and how far the pointer is from the closest one. Integer-only
      // strings, written only when the values change.
      let nearest = Number.POSITIVE_INFINITY;
      for (const p of projected) nearest = Math.min(nearest, Math.hypot(p.x - x, p.y - y));
      const containerEl = containerRef.current;
      if (containerEl) {
        const pins = String(pickablesRef.current.length);
        const dist = Number.isFinite(nearest) ? String(Math.round(nearest)) : 'none';
        if (containerEl.dataset['pins'] !== pins) containerEl.dataset['pins'] = pins;
        if (containerEl.dataset['nearestPx'] !== dist) containerEl.dataset['nearestPx'] = dist;
      }
      return nearestScreenPin(projected, x, y, PICK_TOLERANCE_PX);
    }

    function pickAt(x: number, y: number) {
      onSelectRef.current?.(pickNearest(x, y));
    }

    /* ------------------------------- frame -------------------------------- */
    const clock = new THREE.Clock();
    let lastZoomReported = -1;
    let lastHoverId: string | null = null;
    const animate = () => {
      animRef.current = requestAnimationFrame(animate);
      if (document.hidden) return;
      const t = clock.getElapsedTime();
      const c = camState.current;
      // smooth camera easing
      c.theta += (c.targetTheta - c.theta) * 0.12;
      c.phi += (c.targetPhi - c.phi) * 0.12;
      c.dist += (c.targetDist - c.dist) * 0.12;
      const camera = cameraRef.current!;
      camera.position.set(
        c.dist * Math.sin(c.phi) * Math.cos(c.theta),
        c.dist * Math.cos(c.phi),
        c.dist * Math.sin(c.phi) * Math.sin(c.theta),
      );
      camera.lookAt(0, 0, 0);

      // hover picking every frame while the pointer is over the canvas —
      // the globe may rotate under a still pointer, so a one-shot move handler
      // is not enough (this is why hover previously felt dead).
      const p = pointerRef.current;
      if (p && !dragging) {
        const hovered = pickNearest(p.x, p.y);
        if ((hovered?.id ?? null) !== lastHoverId) {
          lastHoverId = hovered?.id ?? null;
          onHoverRef.current?.(hovered);
          el.style.cursor = hovered ? 'pointer' : 'grab';
        }
      }

      // idle auto-rotation (disabled for reduced motion)
      if (!reducedRef.current && !dragging && pointerRef.current == null) {
        c.targetTheta += 0.0004;
      }

      // report zoom proxy (throttled to whole numbers) for clustering
      const zoomProxy = Math.max(0.5, Math.min(8, (GLOBE_RADIUS * 3.2) / c.dist));
      if (Math.abs(zoomProxy - lastZoomReported) > 0.45) {
        lastZoomReported = zoomProxy;
        onZoomRef.current?.(zoomProxy);
      }

      // update arcs + pulses
      updateArcsFrame(t);
      updateRouteFrame(t);
      updateNodePulses(t);

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animRef.current);
      ro.disconnect();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerleave', onLeave);
      renderer.dispose();
      scene.traverse((obj) => {
        const anyObj = obj as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        anyObj.geometry?.dispose();
        const m = anyObj.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m?.dispose();
      });
      container.removeChild(renderer.domElement);
    };
  }, []);

  /* ---------------------------- node reconciliation ------------------------ */
  const prepared = useMemo<PreparedNode[]>(() => {
    return nodes.map((n) => ({ ...n, pos: lonLatToVec3(n.lon, n.lat) }));
  }, [nodes]);

  // hovered node id (mirrored from page state) drives hover enlargement
  const hoveredId = nodes.find((n) => n.hovered)?.id ?? null;
  useEffect(() => {
    const group = nodesGroupRef.current;
    if (!group) return;
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const base = mesh.userData?.baseScale as number | undefined;
      if (base == null) continue;
      const isHovered = hoveredId != null && mesh.userData?.['id'] === hoveredId;
      mesh.scale.setScalar(isHovered ? base * 1.45 : base);
    }
  }, [hoveredId, prepared]);

  useEffect(() => {
    const group = nodesGroupRef.current;
    if (!group) return;
    // Rebuild marker meshes (cheap at these counts; clustering caps the draw list)
    for (const child of [...group.children]) {
      group.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material;
      mat?.dispose();
    }
    const pickables: PreparedNode[] = [];
    const visualGeo = new THREE.SphereGeometry(BASE_MARKER, 12, 10);
    for (const node of prepared) {
      const color = new THREE.Color(nodeColor(node));
      const material = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(visualGeo, material);
      mesh.position.copy(v3(node.pos));
      const baseScale = node.kind === 'you' ? 1.7 : node.kind === 'hop' ? 0.6 : node.cluster != null ? 1.25 : 1;
      mesh.scale.setScalar(baseScale);
      mesh.userData = { id: node.id, baseScale };
      group.add(mesh);
      pickables.push(node);
    }
    pickablesRef.current = pickables;
    dataRef.current.nodes = prepared;
    // Test/automation hook: how many pins exist on the globe right now.
    if (containerRef.current) containerRef.current.dataset['pins'] = String(pickables.length);
  }, [prepared]);

  /* ----------------------------- arc reconciliation ------------------------ */
  useEffect(() => {
    const group = arcsGroupRef.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      const line = child as THREE.Line & { geometry: THREE.BufferGeometry };
      line.geometry?.dispose();
      (line.material as THREE.Material)?.dispose();
    }
    dataRef.current.arcs = arcs;
    for (const arc of arcs) {
      const pts = arcPoints(arc.from.lat, arc.from.lon, arc.to.lat, arc.to.lon, 48).map(v3);
      const geometry = new THREE.BufferGeometry().setFromPoints(pts);
      const color = new THREE.Color(arc.kind === 'vpn' ? '#fbbf24' : arc.kind === 'historical' ? '#94a3b8' : latencyColor(arc.latencyMs));
      const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: arc.selected ? 0.95 : 0.4 });
      const line = new THREE.Line(geometry, material);
      line.userData = { arc };
      group.add(line);
    }
  }, [arcs]);

  /* ---------------------------- route reconciliation ----------------------- */
  useEffect(() => {
    const group = routeGroupRef.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      const line = child as THREE.Line & { geometry: THREE.BufferGeometry };
      line.geometry?.dispose();
      (line.material as THREE.Material)?.dispose();
    }
    dataRef.current.route = route;
    if (!route) return;
    // Measured route: bright multi-stop polyline through the real hop positions.
    const pts: THREE.Vector3[] = [];
    for (const hop of route.hops) {
      pts.push(v3(lonLatToVec3(hop.lon, hop.lat, GLOBE_RADIUS * 1.01)));
    }
    if (pts.length >= 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(pts);
      const material = new THREE.LineBasicMaterial({ color: 0x22d3ee, linewidth: 2 });
      const line = new THREE.Line(geometry, material);
      group.add(line);
      // hop dots
      const dotGeo = new THREE.SphereGeometry(BASE_MARKER * 0.7, 8, 8);
      const dotMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc });
      for (const p of pts) {
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.copy(p);
        group.add(dot);
      }
    }
  }, [route]);

  /* ------------------------------- focus fly-to ----------------------------- */
  useEffect(() => {
    if (!focus) return;
    const c = camState.current;
    // Convert the focus lat/lon to camera theta/phi so the point faces the camera.
    // thetaForLon derives the exact facing angle from the shared projection
    // convention (see globeMath.ts) — one definition, tested.
    const phi = Math.PI / 2 - THREE.MathUtils.degToRad(focus.lat);
    c.targetPhi = Math.max(0.12, Math.min(Math.PI - 0.12, phi));
    c.targetTheta = thetaForLon(focus.lon);
    c.targetDist = GLOBE_RADIUS * 2.2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  /* -------------------------------- per-frame ------------------------------- */

  function updateArcsFrame(_t: number) {
    // Line opacity breathing for selected arc (cheap: material swap not needed)
    const group = arcsGroupRef.current;
    if (!group) return;
    for (const child of group.children) {
      const line = child as THREE.Line;
      const arc = line.userData?.arc as GlobeArc | undefined;
      const mat = line.material as THREE.LineBasicMaterial;
      if (!arc) continue;
      const targetOpacity = arc.selected ? 0.95 : 0.4;
      mat.opacity += (targetOpacity - mat.opacity) * 0.2;
    }
  }

  function updateRouteFrame(t: number) {
    // Animate a comet along the measured route (real route only — never fabricated)
    const group = routeGroupRef.current;
    if (!group) return;
    // find the comet (a small sphere we add/remove)
    let comet = group.getObjectByName('route-comet') as THREE.Mesh | null;
    const line = group.children.find((c) => (c as THREE.Line).geometry && (c as THREE.Line).type === 'Line') as THREE.Line | undefined;
    if (!line) {
      if (comet) group.remove(comet);
      return;
    }
    const posAttr = line.geometry.getAttribute('position');
    if (!posAttr || reducedRef.current) {
      if (comet) {
        group.remove(comet);
      }
      return;
    }
    if (!comet) {
      comet = new THREE.Mesh(new THREE.SphereGeometry(BASE_MARKER * 1.1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xa5f3fc }));
      comet.name = 'route-comet';
      group.add(comet);
    }
    const count = posAttr.count;
    const tt = (t * 0.18) % 1; // ~5.5s per traversal
    const idx = Math.min(count - 1, Math.floor(tt * (count - 1)));
    const frac = tt * (count - 1) - idx;
    const a = new THREE.Vector3().fromBufferAttribute(posAttr, idx);
    const b = new THREE.Vector3().fromBufferAttribute(posAttr, Math.min(count - 1, idx + 1));
    comet.position.lerpVectors(a, b, frac);
    comet.visible = true;
  }

  /**
   * Selected-pin pulse: one expanding, fading ring hugging the surface at
   * the selected node's position (radius/alpha from the shared ringPulse
   * table — same rhythm as the old 2D canvas). Reduced motion → static
   * double-thick ring, no animation.
   */
  function updateNodePulses(t: number) {
    const group = nodesGroupRef.current;
    if (!group) return;
    const selected = pickablesRef.current.find((n) => n.selected);
    let ring = group.getObjectByName('select-pulse') as THREE.Mesh | null;
    if (!selected) {
      if (ring) group.remove(ring);
      return;
    }
    if (!ring) {
      ring = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1, 40),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.name = 'select-pulse';
      group.add(ring);
    }
    ring.position.copy(v3(selected.pos)).multiplyScalar(1.002);
    // orient the ring tangent to the sphere: lookAt outward along the normal
    ring.lookAt(v3(selected.pos).multiplyScalar(2));
    const base = selected.kind === 'you' ? 1.7 : 1;
    if (reducedRef.current) {
      ring.scale.setScalar(base * 2.2);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.5;
      return;
    }
    const pulse = ringPulse(1.9, t / 1.6);
    ring.scale.setScalar(base * pulse.radiusFactor * 0.75);
    (ring.material as THREE.MeshBasicMaterial).opacity = pulse.alpha;
  }

  // Screen-space tooltip: positioned from the hovered pin's projected
  // screen coords, updated per frame (globe.gl's tooltip is exactly this —
  // a DOM overlay following the projected object position).
  const tipRef = useRef<HTMLDivElement | null>(null);
  const hoveredNode = nodes.find((n) => n.hovered) ?? null;
  useEffect(() => {
    const canvas = rendererRef.current?.domElement;
    if (!canvas || !hoveredNode) return;
    const update = () => {
      const camera = cameraRef.current;
      const el = tipRef.current;
      if (!camera || !el) return;
      const pos = lonLatToVec3(hoveredNode.lon, hoveredNode.lat);
      const projected = v3(pos).project(camera);
      const rect = canvas.getBoundingClientRect();
      const left = ((projected.x + 1) / 2) * rect.width;
      const top = ((1 - projected.y) / 2) * rect.height;
      el.style.left = `${left + 14}px`;
      el.style.top = `${top - 10}px`;
    };
    update();
    let raf = 0;
    const loop = () => {
      update();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hoveredNode]);

  return (
    <div ref={containerRef} className="relative h-full w-full" style={{ cursor: 'grab' }}>
      {hoveredNode && (
        <div
          ref={tipRef}
          className="pointer-events-none absolute z-10 max-w-56 rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] leading-snug shadow-lg backdrop-blur"
        >
          <div className="font-medium text-foreground">{hoveredNode.label}</div>
          {hoveredNode.sub && <div className="truncate font-mono text-[10px] text-faint">{hoveredNode.sub}</div>}
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
            {hoveredNode.cluster != null ? (
              <span className="text-accent">{hoveredNode.cluster} nodes — click to expand</span>
            ) : hoveredNode.latencyMs != null ? (
              <>
                {/* sub-ms RTTs are real (tunnel/colo-local): keep the decimal
                    so the tooltip never rounds a truthful 0.4 ms to "0 ms" */}
                <span className="font-mono">
                  {hoveredNode.latencyMs < 10 ? `${hoveredNode.latencyMs.toFixed(1)} ms` : `${Math.round(hoveredNode.latencyMs)} ms`}
                </span>
                <span className="text-faint">· {hoveredNode.status}</span>
              </>
            ) : (
              <span className="text-faint">{hoveredNode.status}</span>
            )}
            {hoveredNode.geoConfidence && hoveredNode.geoConfidence !== 'unknown' && (
              <span className="text-faint">· {hoveredNode.geoConfidence} geo</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Marker color: kind/status-aware, matching the 2D palette. */
function nodeColor(node: GlobeNode): string {
  if (node.kind === 'you') return '#a78bfa';
  if (node.kind === 'vpn') return '#fbbf24';
  if (node.kind === 'hop') return '#94a3b8';
  if (node.cluster != null) return '#38bdf8';
  switch (node.status) {
    case 'excellent':
      return '#34d399';
    case 'good':
      return '#22d3ee';
    case 'fair':
      return '#fbbf4b';
    case 'poor':
    case 'unreachable':
      return '#f87171';
    default:
      return '#64748b';
  }
}
