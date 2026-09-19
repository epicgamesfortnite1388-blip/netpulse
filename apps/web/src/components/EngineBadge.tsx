/** Local proxy-core runtime that produced a measurement (xray / sing-box / v2ray / hysteria). */
export type ProxyEngine = 'xray' | 'sing-box' | 'v2ray' | 'hysteria';

export const ENGINE_LABELS: Record<ProxyEngine, string> = {
  xray: 'Xray-core',
  'sing-box': 'sing-box',
  v2ray: 'V2Ray-core',
  hysteria: 'Hysteria2',
};

/** Runtime display label for a raw engine value; null → unknown/untested. */
export function engineLabel(engine: string | null | undefined): ProxyEngine | null {
  if (engine === 'xray' || engine === 'sing-box' || engine === 'v2ray' || engine === 'hysteria') return engine;
  return null;
}

const ENGINE_STYLES: Record<ProxyEngine, string> = {
  xray: 'text-sky-400 bg-sky-500/10',
  'sing-box': 'text-fuchsia-400 bg-fuchsia-500/10',
  v2ray: 'text-emerald-400 bg-emerald-500/10',
  hysteria: 'text-violet-400 bg-violet-500/10',
};

/**
 * Colored badge naming the local core (Xray-core / sing-box / V2Ray-core)
 * that produced a measurement. Renders nothing when no engine is recorded —
 * a never-tested or non-proxy measurement must not be labeled with a runtime
 * that didn't run.
 */
export function EngineBadge({ engine, title }: { engine: string | null | undefined; title?: string }) {
  const label = engineLabel(engine);
  if (!label) return null;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${ENGINE_STYLES[label]}`}
      title={title ?? `Measured through the ${ENGINE_LABELS[label]} runtime`}
    >
      {label}
    </span>
  );
}
