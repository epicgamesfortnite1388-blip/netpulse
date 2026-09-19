import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { usePersistentState } from '@/lib/usePersistentState';
import { disclosureKey, foldedSummary, ignoresScopeBroadcast, resolveOpen } from '@/lib/disclosure';

import type { DisclosureSpec } from '@/lib/disclosure';
import type { ReactNode } from 'react';

/**
 * The one collapsible surface in the app.
 *
 * `Card` stays a dumb container; this is the thing that owns "can this be
 * folded, is it folded, and where is that remembered". Section (Surface.tsx)
 * composes it, so a page can mix foldable sections with always-open ones without
 * two implementations of the same idea.
 */

/* -------------------------------- state ---------------------------------- */

/** Page-level fold intent, broadcast to every non-pinned section in the scope. */
interface ScopeValue {
  /** Scope name, part of every section's storage key. */
  name: string;
  /** Increments on each broadcast — the signal sections react to. */
  version: number;
  /** The state the broadcast asks for. */
  open: boolean;
  /** How many foldable sections are mounted (drives whether the control shows). */
  count: number;
  register: (spec: DisclosureSpec) => () => void;
  broadcast: (open: boolean) => void;
}

const ScopeContext = createContext<ScopeValue | null>(null);

/**
 * Wraps a page's sections so a single Expand all / Collapse all can move them
 * together, and gives them a shared storage scope (`name`). Sections still own
 * their own state — the scope only decides when a page-wide action applies.
 */
export function DisclosureScope({ children, name, className = '' }: { children: ReactNode; name: string; className?: string }) {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState(true);
  const [count, setCount] = useState(0);

  const register = useCallback((spec: DisclosureSpec) => {
    setCount((n) => n + 1);
    return () => {
      void spec;
      setCount((n) => Math.max(0, n - 1));
    };
  }, []);

  const broadcast = useCallback((next: boolean) => {
    setOpen(next);
    setVersion((v) => v + 1);
  }, []);

  const value = useMemo<ScopeValue>(
    () => ({ name, version, open, count, register, broadcast }),
    [name, version, open, count, register, broadcast],
  );

  return (
    <ScopeContext.Provider value={value}>
      <div className={className}>{children}</div>
    </ScopeContext.Provider>
  );
}

/**
 * The storage scope for a section rendered outside an explicit
 * `<DisclosureScope>`: still per-page-stable, just not page-wide foldable.
 */
export function useDisclosureScopeName(fallback = 'page'): string {
  return useContext(ScopeContext)?.name ?? fallback;
}

/**
 * A page's fold control. Two explicit actions instead of one ambiguous toggle:
 * "Expand all" and "Collapse all" each do exactly what they say, whichever way
 * the sections currently are.
 *
 * Renders nothing when the page has no foldable section.
 */
export function DisclosureToolbar({ className = '' }: { className?: string }) {
  const scope = useContext(ScopeContext);
  if (!scope || scope.count === 0) return null;
  return (
    <div className={`flex items-center justify-end gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => scope.broadcast(true)}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-faint transition-colors hover:bg-surface-2 hover:text-text"
      >
        <ChevronsUpDown size={12} />
        Expand all
      </button>
      <button
        type="button"
        onClick={() => scope.broadcast(false)}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-faint transition-colors hover:bg-surface-2 hover:text-text"
      >
        <ChevronsDownUp size={12} />
        Collapse all
      </button>
    </div>
  );
}

/**
 * The open state of one section: the user's stored choice, defaulted by the
 * spec, and moved by a page-level broadcast unless the section is pinned.
 *
 * `enabled: false` is for the callers that have to call this hook
 * unconditionally but are not folding anything (a plain `Card`). Such a caller
 * joins no fold group, counts toward no toolbar and writes no storage —
 * otherwise every always-open card would persist under one shared key and be
 * counted as a foldable section.
 */
export function useDisclosure(
  spec: DisclosureSpec,
  scope: string,
  enabled = true,
): [boolean, (open: boolean) => void] {
  // Store the user's explicit choice only; until they make one the section's
  // declared default decides, through the policy module (one owner of the rule).
  const [stored, setStored] = usePersistentState<boolean | null>(disclosureKey(scope, spec), null);
  const open = enabled ? resolveOpen(spec, stored) : spec.defaultOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (enabled) setStored(next);
    },
    [enabled, setStored],
  );
  const scopeValue = useContext(ScopeContext);

  // Keep the latest broadcast in a ref so the effect below fires exactly once per
  // page-level action (re-running it on unrelated context re-renders would fight
  // the user's own clicks on individual sections).
  const intent = useRef<{ version: number; open: boolean }>({ version: 0, open: spec.defaultOpen });
  if (scopeValue) intent.current = { version: scopeValue.version, open: scopeValue.open };

  const { register } = scopeValue ?? {};
  const pinned = ignoresScopeBroadcast(spec) || !enabled;
  const storageId = spec.storageId ?? spec.id;

  useEffect(() => {
    if (!register || !enabled) return;
    return register(spec);
    // Registration is about the section's identity, not its state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, storageId, pinned, enabled]);

  const appliedVersion = useRef(0);
  useEffect(() => {
    if (pinned || !scopeValue) return;
    const { version, open: next } = intent.current;
    if (version === 0 || version === appliedVersion.current) return;
    appliedVersion.current = version;
    setOpen(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeValue?.version, pinned, setOpen]);

  return [open, setOpen];
}

/**
 * A folded explanation. The app has a lot to say about why a number is what it
 * is, and a page that says all of it at once is the reason pages read as
 * complicated. This keeps the prose one click away instead of always on screen:
 * a quiet line of text that unfolds into the full note.
 *
 * Use it for reasoning, never for state — live status belongs in a badge.
 */
export function FoldNote({
  id,
  children,
  label = 'Why this matters',
  defaultOpen = false,
  className = '',
}: {
  id: string;
  children: ReactNode;
  label?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const scope = useDisclosureScopeName();
  const [open, setOpen] = useDisclosure({ id: `note:${id}`, defaultOpen }, scope);
  const bodyId = `note-${scope}-${id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  return (
    <div className={`text-xs ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="inline-flex items-center gap-1 text-faint transition-colors hover:text-muted"
      >
        <ChevronDown size={12} aria-hidden className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
        {label}
      </button>
      {open && (
        <div id={bodyId} className="mt-1.5 rounded-r-lg border-l-2 border-line bg-surface-2/50 px-3 py-2 leading-relaxed text-muted animate-fade-up">
          {children}
        </div>
      )}
    </div>
  );
}

/** The chevron: points right when folded, down when open. */
function FoldChevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      size={15}
      aria-hidden
      className={`shrink-0 text-faint transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
    />
  );
}

/* ------------------------------- surfaces -------------------------------- */

interface CollapsibleCardProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Always-visible line shown ONLY while folded: what is inside, in counts. */
  summary?: ReactNode;
  /** Always-visible status chip (a live state), folded or not. */
  badge?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Rendered next to the title, inside the fold target. */
  children: ReactNode;
  /**
   * Set false to render a plain, always-open card — the same component decides
   * both cases so a page never mixes two header styles.
   */
  collapsible?: boolean;
  defaultOpen?: boolean;
  pinned?: boolean;
  /** Unique within the page; also the storage identity. */
  id: string;
  scope: string;
  className?: string;
  /** Extra content that stays visible while folded (e.g. a warning). */
  keepVisible?: ReactNode;
}

/**
 * A titled panel that folds. The header is the fold target — a real button, so
 * it is keyboard-reachable and reports `aria-expanded` — and it stays
 * informative while folded (badge + summary), because a collapsed section that
 * hides its state just moves the guessing elsewhere.
 */
export function CollapsibleCard({
  title,
  subtitle,
  summary,
  badge,
  icon,
  actions,
  children,
  collapsible = true,
  defaultOpen = true,
  pinned = false,
  id,
  scope,
  className = '',
  keepVisible,
}: CollapsibleCardProps) {
  const spec: DisclosureSpec = { id, defaultOpen, pinned };
  const [open, setOpen] = useDisclosure(spec, scope);
  const bodyId = `section-${scope}-${id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const folded = collapsible && !open;
  const foldedNote = folded ? foldedSummary(typeof summary === 'string' ? summary : undefined) : null;

  const header = (
    <>
      {collapsible && <FoldChevron open={open} />}
      {icon && <span className="mt-0.5 shrink-0 text-accent">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold tracking-tight">{title}</span>
          {badge}
        </span>
        {/* While folded, the summary stands in for the subtitle: one line, and
            the line that says what is inside. Both at once reads as clutter. */}
        {subtitle && !(folded && foldedNote) && <span className="mt-0.5 block text-xs text-muted">{subtitle}</span>}
        {folded && foldedNote && <span className="mt-0.5 block text-xs text-faint">{foldedNote}</span>}
      </span>
      {actions && (
        <span className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </>
  );

  return (
    <section className={`mb-5 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.4)] ${className}`}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex w-full items-start gap-2.5 rounded-t-xl px-5 py-3.5 text-left transition-colors hover:bg-surface-2/50"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-start gap-2.5 border-b border-line px-5 py-3.5">{header}</div>
      )}
      {!folded && (
        <div id={bodyId} className={`border-t border-line px-5 py-4 ${collapsible ? 'animate-fade-up' : ''}`}>
          {children}
        </div>
      )}
      {keepVisible}
    </section>
  );
}
