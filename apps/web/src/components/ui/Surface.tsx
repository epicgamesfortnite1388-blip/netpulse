import { Check, ChevronDown, HelpCircle, Minus, X } from 'lucide-react';

import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CollapsibleCard, useDisclosure, useDisclosureScopeName } from '@/components/ui/Disclosure';

import type { DisclosureSpec } from '@/lib/disclosure';
import type { ReactNode } from 'react';

/**
 * Shared surface chrome: the hero, section, tile and capability primitives the
 * engine pages are built from. They exist so a page reads as
 * hero → sections → tiles instead of a stack of equally-weighted cards nested
 * inside one another.
 *
 * Lives in components/ui (rather than inside a feature) because the VPN
 * surfaces and the node pages both compose them.
 */

/** A gradient glyph tile holding a page/section icon. */
export function EngineGlyph({ glyph, children, size = 'md' }: { glyph: string; children: ReactNode; size?: 'md' | 'lg' }) {
  const dims = size === 'lg' ? 'h-14 w-14 text-2xl' : 'h-10 w-10 text-lg';
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center rounded-xl border border-line bg-gradient-to-br ${glyph} ${dims}`}
    >
      {children}
    </span>
  );
}

/**
 * The header of a page/surface: identity, live badges, actions, an optional
 * description and an optional visual panel (e.g. the Aether WebGL core).
 */
export function EngineHero({
  glyph,
  name,
  tagline,
  badges,
  actions,
  description,
  visual,
  footer,
}: {
  glyph: ReactNode;
  name: ReactNode;
  tagline: string;
  badges?: ReactNode;
  actions?: ReactNode;
  description?: string;
  /** Optional panel rendered to the right. */
  visual?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative mb-5 overflow-hidden rounded-xl border border-line-strong bg-surface">
      {/* soft directional glow; purely decorative */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(120% 130% at 6% -20%, rgba(34, 211, 238, 0.10), transparent 55%), radial-gradient(100% 120% at 96% -10%, rgba(168, 85, 247, 0.12), transparent 60%)',
        }}
      />
      <div className={`relative grid gap-5 p-5 ${visual ? 'lg:grid-cols-[minmax(0,1fr)_minmax(300px,370px)] lg:items-center lg:gap-7' : ''}`}>
        <div className="min-w-0">
          <div className="flex items-start gap-3.5">
            {glyph}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold tracking-tight">{name}</h2>
                {badges}
              </div>
              <p className="mt-0.5 text-xs uppercase tracking-[0.14em] text-faint">{tagline}</p>
            </div>
          </div>
          {description && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>}
          {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
          {footer && <div className="mt-3">{footer}</div>}
        </div>
        {visual && <div className="min-w-0">{visual}</div>}
      </div>
    </div>
  );
}

/**
 * A titled section. Thin wrapper over Card so every surface uses the same
 * heading rhythm and the nesting stays one level deep.
 *
 * `variant="flat"` drops the container entirely: the section becomes a heading
 * separated by a hairline. Use it on surfaces that hold their own panels — a
 * bordered section with bordered panels inside it is the box-inside-a-box this
 * primitive exists to prevent.
 *
 * FOLDING (`collapsible`): a page with eight equally-open sections reads as
 * complicated, so secondary ones fold. Pass `id` (stable, unique on the page),
 * `defaultOpen={false}` for anything that is reference material rather than the
 * task, and a `summary` so the folded header still says what is inside. `pinned`
 * keeps the section out of the page-level fold. `badge` survives folding — a
 * collapsed section must never hide live state.
 */
export function Section({
  title,
  subtitle,
  icon,
  actions,
  children,
  className = '',
  variant = 'card',
  collapsible = false,
  defaultOpen = true,
  pinned = false,
  id,
  summary,
  badge,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: 'card' | 'flat';
  collapsible?: boolean;
  defaultOpen?: boolean;
  pinned?: boolean;
  /** Required when `collapsible`: stable identity within the page. */
  id?: string;
  summary?: string;
  badge?: ReactNode;
}) {
  const scope = useDisclosureScopeName();
  const sectionId = id ?? (typeof title === 'string' ? title : 'section');

  if (variant === 'flat') {
    return (
      <FlatSection
        title={title}
        subtitle={subtitle}
        icon={icon}
        actions={actions}
        className={className}
        collapsible={collapsible}
        summary={summary}
        badge={badge}
        spec={{ id: sectionId, defaultOpen, pinned }}
        scope={scope}
      >
        {children}
      </FlatSection>
    );
  }

  if (collapsible) {
    return (
      <CollapsibleCard
        title={title}
        subtitle={subtitle}
        icon={icon}
        actions={actions}
        summary={summary}
        badge={badge}
        id={sectionId}
        scope={scope}
        defaultOpen={defaultOpen}
        pinned={pinned}
        className={className}
      >
        {children}
      </CollapsibleCard>
    );
  }

  return (
    <Card className={`mb-5 ${className}`}>
      <CardHeader title={title} subtitle={subtitle} icon={icon} actions={actions} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

/**
 * The `variant="flat"` section, with optional folding. Flat sections carry no
 * container of their own, so folding them is a chevron in the heading rather
 * than another bordered header.
 */
function FlatSection({
  title,
  subtitle,
  icon,
  actions,
  children,
  className,
  collapsible,
  summary,
  badge,
  spec,
  scope,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className: string;
  collapsible: boolean;
  summary?: string;
  badge?: ReactNode;
  spec: DisclosureSpec;
  scope: string;
}) {
  const [open, setOpen] = useDisclosure(spec, scope);
  const folded = collapsible && !open;
  const bodyId = `flat-${scope}-${spec.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const heading = (
    <>
      {collapsible && (
        <ChevronDown size={14} aria-hidden className={`mt-1 shrink-0 text-faint transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
      )}
      {icon && <span className="mt-0.5 text-accent">{icon}</span>}
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold tracking-tight">{title}</span>
          {badge}
        </span>
        {subtitle && !folded && <span className="mt-0.5 block max-w-3xl text-xs leading-relaxed text-muted">{subtitle}</span>}
        {folded && summary && <span className="mt-0.5 block text-xs text-faint">{summary}</span>}
      </span>
    </>
  );
  return (
    <section className={`mb-7 border-t border-line pt-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg text-left transition-colors hover:text-text"
          >
            {heading}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2.5">{heading}</div>
        )}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {!folded && (
        <div id={bodyId} className="mt-3.5">
          {children}
        </div>
      )}
    </section>
  );
}

/** A single headline number with an honest hint about where it came from. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger' | 'faint';
}) {
  const toneClass =
    tone === 'ok'
      ? 'text-ok'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'danger'
          ? 'text-danger'
          : tone === 'faint'
            ? 'text-faint'
            : 'text-text';
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">{label}</p>
      <p className={`metric-num mt-1 text-lg font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-faint">{hint}</p>}
    </div>
  );
}

export type CapabilityState = 'yes' | 'no' | 'partial' | 'unknown';

export interface CapabilityRow {
  label: string;
  state: CapabilityState;
  note?: string;
}

const CAP_ICON: Record<CapabilityState, ReactNode> = {
  yes: <Check size={13} />,
  no: <X size={13} />,
  partial: <Minus size={13} />,
  unknown: <HelpCircle size={13} />,
};

const CAP_STYLE: Record<CapabilityState, string> = {
  yes: 'border-ok/30 bg-ok/10 text-ok',
  no: 'border-danger/25 bg-danger/10 text-danger',
  partial: 'border-warn/30 bg-warn/10 text-warn',
  unknown: 'border-line bg-surface-2 text-faint',
};

const CAP_WORD: Record<CapabilityState, string> = {
  yes: 'supported',
  no: 'not supported',
  partial: 'partial',
  unknown: 'unknown',
};

/**
 * Honest capability grid. Rows describe DOCUMENTED behaviour (mapped to backend
 * guards), never a live measurement — the wording says so.
 */
export function CapabilityMatrix({ rows }: { rows: CapabilityRow[] }) {
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.label} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line pb-1.5 last:border-b-0 last:pb-0">
          <span
            className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${CAP_STYLE[row.state]}`}
            title={CAP_WORD[row.state]}
            aria-label={CAP_WORD[row.state]}
          >
            {CAP_ICON[row.state]}
          </span>
          <span className="min-w-0 flex-1 text-sm text-text">{row.label}</span>
          {row.note && <span className="text-xs leading-snug text-faint">{row.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A compact labelled value used inside list rows. */
export function MiniMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-2 py-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-faint">{label}</p>
      <p className="metric-num text-xs text-text">{value}</p>
    </div>
  );
}

/** `Label: value` pill used by always-visible status strips. */
export function FieldPill({ label, value, tone }: { label: string; value: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'danger' }) {
  const toneClass = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-text';
  return (
    <span className="text-sm text-muted">
      {label}: <span className={toneClass}>{value}</span>
    </span>
  );
}

/* ------------------------------------------------------------------------- *
 * Flat primitives.
 *
 * The chrome above puts one border around a group. These put ZERO extra
 * borders inside that group: metrics share one strip, values share one list,
 * grouped controls share a tone-only panel, and status messages use a left
 * rule. That is what keeps a page from reading as boxes inside boxes.
 * ------------------------------------------------------------------------- */

export type MetricTone = 'default' | 'ok' | 'warn' | 'danger' | 'faint';

function toneText(tone: MetricTone): string {
  return tone === 'ok'
    ? 'text-ok'
    : tone === 'warn'
      ? 'text-warn'
      : tone === 'danger'
        ? 'text-danger'
        : tone === 'faint'
          ? 'text-faint'
          : 'text-text';
}

export interface MetricItem {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricTone;
  /** Renders the value in the monospace metric face (IPs, ms, counters). */
  mono?: boolean;
}

/**
 * Several headline numbers in ONE bordered strip, separated by hairlines. A
 * strip of N tiles would be N boxes; this is one, and it stays legible when the
 * values are long (core lists, exit IPs).
 */
export function MetricStrip({ items, className = '' }: { items: MetricItem[]; className?: string }) {
  // Vertical rules only make sense while every item sits on one line, i.e. up
  // to four items at the widest breakpoint. Beyond that, spacing separates.
  const ruled = items.length <= 4;
  return (
    <div
      className={`grid gap-y-3 rounded-xl border border-line bg-surface px-4 py-3 sm:grid-cols-2 ${
        items.length >= 4 ? 'lg:grid-cols-4' : items.length === 3 ? 'lg:grid-cols-3' : ''
      } ${className}`}
    >
      {items.map((item, i) => (
        <div key={item.label} className={`min-w-0 ${ruled && i > 0 ? 'sm:border-l sm:border-line sm:pl-4' : ''}`}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{item.label}</p>
          <p className={`mt-1 truncate text-[15px] font-semibold ${item.mono ? 'metric-num' : ''} ${toneText(item.tone ?? 'default')}`}>
            {item.value}
          </p>
          {item.hint && <p className="mt-0.5 truncate text-[11px] leading-snug text-faint">{item.hint}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * A borderless inset region: grouped controls or attributed data inside a
 * section. Tone only — never a second border.
 */
export function Panel({
  children,
  tone = 'default',
  className = '',
}: {
  children: ReactNode;
  tone?: 'default' | 'quiet' | 'accent' | 'aether';
  className?: string;
}) {
  const tones = {
    default: 'bg-surface-2/70',
    quiet: 'bg-surface/60',
    accent: 'bg-accent-soft',
    aether: 'bg-aether-soft',
  } as const;
  return <div className={`rounded-lg ${tones[tone]} px-3.5 py-3 ${className}`}>{children}</div>;
}

/**
 * Inline status message. A left rule instead of a full border, so a warning can
 * sit inside a panel or a section without adding another rectangle.
 */
export function Notice({
  tone = 'info',
  children,
  className = '',
  icon,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'danger';
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  const tones = {
    info: 'border-accent/50 bg-accent-soft/50 text-muted',
    ok: 'border-ok/50 bg-ok/5 text-muted',
    warn: 'border-warn/60 bg-warn/5 text-warn',
    danger: 'border-danger/60 bg-danger/5 text-danger',
  } as const;
  return (
    <div className={`flex items-start gap-2 rounded-r-lg border-l-2 ${tones[tone]} px-3.5 py-2.5 text-xs leading-relaxed ${className}`}>
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Compact capability chip — lit for supported, dimmed and labelled for not. */
export function Chip({
  state = 'on',
  children,
  title,
  className = '',
}: {
  state?: 'on' | 'off' | 'partial';
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const tones = {
    on: 'border-ok/30 bg-ok/10 text-ok',
    off: 'border-line bg-surface-2 text-faint',
    partial: 'border-warn/30 bg-warn/10 text-warn',
  } as const;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-none ${tones[state]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A hairline-separated list. Rows are plain — no per-row container. */
export function DataList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ul className={`divide-y divide-line ${className}`}>{children}</ul>;
}

/**
 * One row of a data list: optional leading glyph, identity, meta line and
 * trailing actions. Hover highlights the row instead of the row being a box.
 */
export function DataRow({
  leading,
  title,
  subtitle,
  meta,
  actions,
  onClick,
  tone = 'default',
  className = '',
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'active';
  className?: string;
}) {
  const body = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span>}
        {meta && <span className="mt-0.5 block text-[11px] text-faint">{meta}</span>}
      </span>
      {actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
    </>
  );

  const classes = `flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors ${
    tone === 'active' ? 'bg-aether-soft/60' : ''
  } ${className}`;

  if (!onClick) return <li className={classes}>{body}</li>;
  return (
    <li>
      <button type="button" onClick={onClick} className={`${classes} hover:bg-surface-2/60`}>
        {body}
      </button>
    </li>
  );
}

/** Loading placeholder that matches the final layout instead of a spinner. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}
