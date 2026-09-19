import { useEffect, useRef, useState } from 'react';

import * as THREE from 'three';

/**
 * The Aether living core — a WebGL visual bound to the REAL tunnel state.
 *
 * It is deliberately a pure function of `state`: it animates faster and brighter
 * while the tunnel is coming up and while it is carrying traffic, and goes dim
 * and red when the engine is down. It never invents a status of its own — the
 * caller passes the state it read from the backend, so this can never look
 * "connected" while the app says otherwise.
 *
 * Constraints honoured here (the webview is a long-lived desktop process):
 *   - every GPU resource is disposed and every listener removed on unmount
 *   - rendering pauses while the document is hidden
 *   - prefers-reduced-motion renders a single settled frame instead of looping
 *   - a lost WebGL context degrades to the CSS orb rather than a blank box
 *   - lazy-loaded by the caller, so no WebGL context exists off the Aether tab
 */

export type CoreState = 'idle' | 'starting' | 'active' | 'down';

interface Palette {
  inner: number;
  mid: number;
  outer: number;
  points: number;
  speed: number;
  intensity: number;
}

/*
 * Palettes are tuned for a dark "portal" panel (see AetherSurface): deep
 * near-black cores, a saturated mid tone that carries the state, and a bright
 * rim that only shows on the fresnel edge. Speeds stay deliberately low — an
 * "otherworldly" core reads as a slow, deliberate drift, not a spinner, and
 * high angular speed made the cage and rings strobe at this size.
 */
const PALETTES: Record<CoreState, Palette> = {
  idle: { inner: 0x1e1b4b, mid: 0x4f46e5, outer: 0x22d3ee, points: 0x818cf8, speed: 0.09, intensity: 0.72 },
  starting: { inner: 0x78350f, mid: 0xfbbf24, outer: 0xfde68a, points: 0xfbbf24, speed: 0.55, intensity: 1.1 },
  active: { inner: 0x2e1065, mid: 0xa855f7, outer: 0x22d3ee, points: 0xf0abfc, speed: 0.3, intensity: 1.75 },
  down: { inner: 0x450a0a, mid: 0xdc2626, outer: 0xfca5a5, points: 0xf87171, speed: 0.07, intensity: 0.55 },
};

const VERTEX_SHADER = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform vec3 uInner;
uniform vec3 uMid;
uniform vec3 uOuter;
varying vec3 vNormal;
varying vec3 vView;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  float fres = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), 2.4);
  float flow = 0.5 + 0.5 * sin(n.y * 9.0 + uTime * 1.3);
  float pulse = 0.85 + 0.15 * sin(uTime * 2.1);
  vec3 col = mix(uInner, uMid, flow);
  col = mix(col, uOuter, fres * 0.9);
  float alpha = clamp(0.16 + fres * 0.85, 0.0, 1.0) * clamp(uIntensity, 0.0, 2.0);
  gl_FragColor = vec4(col * (0.6 + fres * 1.5) * pulse, alpha);
}
`;

/** CSS-only stand-in used when WebGL is unavailable or its context is lost. */
function CssOrb({ state }: { state: CoreState }) {
  const hue = state === 'active' ? 'from-violet-500/70 via-cyan-400/50 to-fuchsia-400/40'
    : state === 'starting' ? 'from-amber-400/60 via-amber-300/40 to-yellow-200/30'
      : state === 'down' ? 'from-red-500/50 via-red-400/30 to-rose-300/20'
        : 'from-indigo-500/50 via-violet-400/30 to-cyan-300/20';
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className={`aether-halo h-32 w-32 rounded-full bg-gradient-to-br blur-md ${hue}`} />
    </div>
  );
}

export default function AetherCore({ state = 'idle', className = '' }: { state?: CoreState; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<CoreState>(state);
  /** Re-renders one settled frame (reduced motion / context safety). */
  const renderOnceRef = useRef<(() => void) | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  // Keep the read ref current and reflect an immediate state change when the
  // animation loop is intentionally not running.
  useEffect(() => {
    stateRef.current = state;
    renderOnceRef.current?.();
  }, [state]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
      const ctx = renderer.getContext();
      if (!ctx) throw new Error('no webgl context');
    } catch {
      setUnsupported(true);
      return undefined;
    }

    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    // Framing: at fov 40 and z=4.6 the visible half-height at the origin is
    // ~1.67, so the rings (r=1.62) sit just inside the frame and only the
    // outermost particles drift off the edge — composition instead of cropping.
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 4.6);

    // ---- inner core -------------------------------------------------------
    const uniforms = {
      uTime: { value: 0 },
      uIntensity: { value: PALETTES.idle.intensity },
      uInner: { value: new THREE.Color(PALETTES.idle.inner) },
      uMid: { value: new THREE.Color(PALETTES.idle.mid) },
      uOuter: { value: new THREE.Color(PALETTES.idle.outer) },
    };
    const coreGeo = new THREE.IcosahedronGeometry(0.92, 6);
    const coreMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);

    // ---- counter-rotating cage -------------------------------------------
    const cageGeo = new THREE.IcosahedronGeometry(1.42, 1);
    const cageMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.1 });
    const cage = new THREE.Mesh(cageGeo, cageMat);

    // ---- orbit conduits ---------------------------------------------------
    const ringGeo = new THREE.TorusGeometry(1.62, 0.0032, 6, 220);
    const ringMatA = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false });
    const ringMatB = new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false });
    const ringA = new THREE.Mesh(ringGeo, ringMatA);
    const ringB = new THREE.Mesh(ringGeo, ringMatB);
    ringA.rotation.set(Math.PI / 2.6, 0.4, 0);
    ringB.rotation.set(Math.PI / 1.9, -0.6, 0.5);

    // ---- particle shell ---------------------------------------------------
    const COUNT = 620;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i += 1) {
      // Uniform-ish shell between r=1.15 and r=1.95 — denser around the core
      // reads as a halo rather than scattered dust.
      const theta = Math.acos(1 - 2 * Math.random());
      const phi = Math.random() * Math.PI * 2;
      const r = 1.15 + Math.random() * 0.8;
      const idx = i * 3;
      positions[idx] = r * Math.sin(theta) * Math.cos(phi);
      positions[idx + 1] = r * Math.cos(theta);
      positions[idx + 2] = r * Math.sin(theta) * Math.sin(phi);
    }
    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pointsMat = new THREE.PointsMaterial({
      size: 0.028,
      color: new THREE.Color(PALETTES.idle.points),
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(pointsGeo, pointsMat);

    const group = new THREE.Group();
    group.add(core, cage, ringA, ringB, points);
    scene.add(group);

    // ---- state → palette blending ----------------------------------------
    const tmp = new THREE.Color();
    let speed = PALETTES.idle.speed;

    function tick(delta: number): void {
      const pal = PALETTES[stateRef.current];
      // Slower blend than the frame rate: a state change cross-fades over ~0.6 s
      // instead of snapping, which is what makes the transitions feel deliberate.
      const blend = Math.min(1, delta * 1.6);
      uniforms.uInner.value.lerp(tmp.setHex(pal.inner), blend);
      uniforms.uMid.value.lerp(tmp.setHex(pal.mid), blend);
      uniforms.uOuter.value.lerp(tmp.setHex(pal.outer), blend);
      uniforms.uIntensity.value += (pal.intensity - uniforms.uIntensity.value) * blend;
      speed += (pal.speed - speed) * blend;
      cageMat.color.lerp(tmp.setHex(pal.outer), blend);
      pointsMat.color.lerp(tmp.setHex(pal.points), blend);

      uniforms.uTime.value += delta * (0.5 + speed * 2.0);
      group.rotation.y += delta * speed * 0.62;
      group.rotation.x += delta * speed * 0.16;
      // Slow vertical bob — the single biggest cue that this is alive and not
      // a looping animation. Kept tiny so the composition never drifts out of frame.
      group.position.y = Math.sin(uniforms.uTime.value * 0.55) * 0.035;
      cage.rotation.y -= delta * speed * 1.25;
      cage.rotation.z += delta * speed * 0.42;
      ringA.rotation.z += delta * speed * 1.05;
      ringB.rotation.z -= delta * speed * 0.8;
      points.rotation.y -= delta * speed * 0.3;
    }

    let raf = 0;
    let last = performance.now();

    const renderFrame = (): void => {
      renderer.render(scene, camera);
    };

    const loop = (now: number): void => {
      const delta = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      tick(delta);
      renderFrame();
      raf = window.requestAnimationFrame(loop);
    };

    const start = (): void => {
      if (reduced || raf !== 0) return;
      last = performance.now();
      raf = window.requestAnimationFrame(loop);
    };

    const stop = (): void => {
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    /** Settle the palette over a few fixed steps and draw one frame. */
    const settle = (): void => {
      for (let i = 0; i < 24; i += 1) tick(0.05);
      renderFrame();
    };
    // Only draw on demand while the loop is NOT running (reduced motion, or a
    // hidden/paused document). Settling during animation would apply 1.2 s of
    // simulated time instantly — the palette cross-fade and the rotation would
    // visibly snap on every connect/disconnect instead of easing.
    renderOnceRef.current = () => {
      if (raf === 0) settle();
    };

    const resize = (): void => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (reduced) settle();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // A lost context cannot be recovered meaningfully here; fall back to the
    // CSS orb so the panel never renders as an empty rectangle.
    const onContextLost = (event: Event): void => {
      event.preventDefault();
      stop();
      // The canvas is absolutely positioned, so it paints ABOVE in-flow content:
      // leaving it in place would hide the fallback behind a dead surface.
      canvas.style.display = 'none';
      setUnsupported(true);
    };
    canvas.addEventListener('webglcontextlost', onContextLost);

    if (reduced) settle();
    else start();

    return () => {
      stop();
      renderOnceRef.current = null;
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      group.clear();
      coreGeo.dispose();
      coreMat.dispose();
      cageGeo.dispose();
      cageMat.dispose();
      ringGeo.dispose();
      ringMatA.dispose();
      ringMatB.dispose();
      pointsGeo.dispose();
      pointsMat.dispose();
      // three's dispose() frees its own caches but does NOT release the WebGL
      // context. Each Aether tab visit would otherwise consume one of the
      // webview's ~16 live contexts and, once exhausted, context creation
      // starts failing — the core renders nothing and looks broken. Losing the
      // context explicitly is what makes repeated tab switching safe.
      renderer.forceContextLoss();
      renderer.dispose();
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  }, []);

  // No border or background here: the caller frames this in its own "portal"
  // panel (see AetherSurface), so the core can bleed its glow to the edges.
  return (
    <div className={`relative h-full w-full overflow-hidden ${className}`} style={{ minHeight: 200 }}>
      <div
        aria-hidden
        className="aether-aurora pointer-events-none absolute inset-[-25%] opacity-80"
        style={{ background: 'conic-gradient(from 0deg, rgba(168,85,247,0.18), rgba(34,211,238,0.14), rgba(244,114,182,0.12), rgba(168,85,247,0.18))' }}
      />
      <div aria-hidden className="aether-grid pointer-events-none absolute inset-0 opacity-40" />
      <div ref={hostRef} className="absolute inset-0" aria-hidden />
      {/* Above the canvas: the fallback must win the paint order, not sit under it. */}
      {unsupported && (
        <div className="absolute inset-0 z-10">
          <CssOrb state={state} />
        </div>
      )}
      {/* Vignette: fades the particle field into the panel edge so nothing reads
          as cropped. Sits above the canvas, which is why it must stay inert. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(125% 105% at 50% 45%, transparent 50%, rgba(4,3,12,0.6) 100%)' }}
      />
    </div>
  );
}
