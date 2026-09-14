/** Local proxy-core runtime that produced a measurement (xray / sing-box). */
export type ProxyEngine = 'xray' | 'sing-box';

/** Runtime display label for a raw engine value; null → unknown/untested. */
export function engineLabel(engine: string | null | undefined): string | null {
  if (engine === 'xray') return 'xray';
  if (engine === 'sing-box') return 'sing-box';
  return null;
}

/**
 * Colored badge naming the local core (Xray-core / sing-box) that produced a
 * measurement. Renders nothing when no engine is recorded — a never-tested or
 * non-proxy measurement must not be labeled with a runtime that didn't run.
 */
export function EngineBadge({ engine, title }: { engine: string | null | undefined; title?: string }) {
  const label = engineLabel(engine);
  if (!label) return null;
  const style = label === 'xray' ? 'text-sky-400 bg-sky-500/10' : 'text-fuchsia-400 bg-fuchsia-500/10';
  const name = label === 'xray' ? 'Xray-core' : 'sing-box';
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${style}`}
      title={title ?? `Measured through the ${name} runtime`}
    >
      {label}
    </span>
  );
}
