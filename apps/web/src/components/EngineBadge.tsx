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

/**
 * One tint for every engine. The per-engine hues were decoration: the label
 * already names the runtime, and the four arbitrary palette colours had no
 * light-theme counterpart, so the badge's tint vanished on a white card.
 */
const ENGINE_BADGE_CLASS = 'text-accent bg-accent-soft';

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
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${ENGINE_BADGE_CLASS}`}
      title={title ?? `Measured through the ${ENGINE_LABELS[label]} runtime`}
    >
      {label}
    </span>
  );
}
