import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  Activity,
  ChevronDown,
  Cloud,
  CloudCog,
  Cpu,
  Download,
  Flag,
  Gauge,
  Gamepad2,
  Globe,
  HeartPulse,
  History,
  Loader2,
  Menu,
  Radio,
  Radar,
  Route,
  Search,
  Server,
  Settings,
  Shield,
  Stethoscope,
  TriangleAlert,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { CommandPalette } from '@/components/CommandPalette';
import { QuickConnectOverlay } from '@/components/QuickConnectOverlay';
import { startSyncLoop, stopSyncLoop } from '@/lib/cloud/syncEngine';
import { useCloudSession } from '@/lib/cloud/useCloudSession';
import { useStartupHealth } from '@/lib/useStartupHealth';
import { DemoBadge } from '@/components/ui/Badge';
import { PageSkeleton } from '@/components/ui/States';
import { StatusDot } from '@/components/ui/StatusDot';
import { UpdateBanner } from '@/features/settings/UpdateBanner';
import { api } from '@/lib/api';
import { overlayShortcut } from '@/lib/quickConnect';
import { usePersistentState } from '@/lib/usePersistentState';
import { useThemeApplier } from '@/app/useTheme';
import { useTypeScaleApplier } from '@/app/useTypeScale';

import type { ReactNode } from 'react';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

/**
 * A parent row that expands into its own destinations.
 *
 * `children` is what makes an entry a section rather than a link — the node
 * area (Explorer / Sources / Engines) is one dataset with several views, so the
 * sidebar shows that grouping instead of flattening them into Infrastructure.
 */
interface NavSection {
  label: string;
  icon: ReactNode;
  children: NavItem[];
}

type NavEntry = NavItem | NavSection;

function isSection(entry: NavEntry): entry is NavSection {
  return 'children' in entry;
}

interface NavGroup {
  heading: string;
  items: NavEntry[];
}

const NAV: NavGroup[] = [
  {
    heading: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: <Gauge size={16} />, end: true },
      { to: '/map', label: 'Live Map', icon: <Globe size={16} /> },
      { to: '/health', label: 'System Health', icon: <Stethoscope size={16} /> },
    ],
  },
  {
    heading: 'Diagnostics',
    items: [
      { to: '/diagnostics', label: 'Quick Check', icon: <HeartPulse size={16} /> },
      { to: '/speed-test', label: 'Speed Test', icon: <Waves size={16} /> },
      { to: '/dns', label: 'DNS', icon: <Radar size={16} /> },
      { to: '/ip', label: 'IP', icon: <Globe size={16} /> },
      { to: '/routes', label: 'Routes', icon: <Route size={16} /> },
      { to: '/cloudflare', label: 'Cloudflare', icon: <Cloud size={16} /> },
    ],
  },
  {
    heading: 'Gaming',
    items: [{ to: '/gaming', label: 'Gaming', icon: <Gamepad2 size={16} /> }],
  },
  {
    heading: 'Iran',
    items: [{ to: '/iran', label: 'Iran Connectivity', icon: <Flag size={16} /> }],
  },
  {
    heading: 'Infrastructure',
    items: [
      { to: '/servers', label: 'Servers', icon: <Server size={16} /> },
      { to: '/vpn', label: 'VPN', icon: <Shield size={16} /> },
      { to: '/optimizer', label: 'Optimizer', icon: <Activity size={16} /> },
      {
        label: 'Nodes',
        icon: <Radar size={16} />,
        children: [
          { to: '/nodes', label: 'Explorer', icon: <Radar size={14} /> },
          { to: '/nodes-sources', label: 'Sources', icon: <Download size={14} /> },
          { to: '/engines', label: 'Engines', icon: <Cpu size={14} /> },
        ],
      },
    ],
  },
  {
    heading: 'Data',
    items: [
      { to: '/history', label: 'History', icon: <History size={16} /> },
      { to: '/events', label: 'Events', icon: <Radio size={16} /> },
    ],
  },
  {
    heading: 'System',
    items: [
      { to: '/account', label: 'Account', icon: <CloudCog size={16} /> },
      { to: '/settings', label: 'Settings', icon: <Settings size={16} /> },
    ],
  },
];

interface Meta {
  demoMode: boolean;
  safeMode?: boolean;
}

function useMeta() {
  // fetched once per app lifetime; failure degrades to "backend offline" —
  // the banner below surfaces it honestly instead of faking a Live state.
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    api
      .get<Meta>('/meta')
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);
  return meta;
}

function isChildActive(child: NavItem, pathname: string): boolean {
  return pathname === child.to || pathname.startsWith(`${child.to}/`);
}

/**
 * Is this destination the current one?
 *
 * The same rule decides the row's ink AND which row the travelling pill parks
 * on, so the two can never disagree — before this, the highlight came from
 * NavLink's own `isActive` while the section's collapsed state used a second,
 * hand-written rule, and `end` was only honoured by one of them.
 */
function isLinkActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** Every collapsible section in the nav, derived so the two never drift apart. */
const NAV_SECTIONS = NAV.flatMap((group) => group.items).filter(isSection);

// The active row carries no background of its own: the travelling pill in
// `SidebarContent` is the highlight. Two backgrounds would double the tint on
// the row the pill happens to be resting on.
const linkClass = (isActive: boolean) =>
  `nav-row flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
    isActive ? 'text-accent-strong' : 'text-muted hover:bg-surface-2 hover:text-text'
  }`;

/**
 * A collapsible nav section: the parent toggles, the children navigate.
 *
 * The parent still lights up when one of its children is the current page, so a
 * collapsed section never hides where you are.
 */
function NavSectionEntry({
  section,
  pathname,
  open,
  onToggle,
  onNavigate,
}: {
  section: NavSection;
  pathname: string;
  open: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  const active = section.children.some((child) => isChildActive(child, pathname));
  const panelId = `nav-section-${section.label.toLowerCase()}`;
  // The pill marks the section row only while it is collapsed — when it is open
  // the active child is the row being pointed at, and two pills would be two
  // answers to "where am I".
  const pillHere = active && !open;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        data-nav-current={pillHere ? 'true' : undefined}
        className={`nav-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
          active && !open
            ? 'text-accent-strong'
            : active
              ? 'text-text hover:bg-surface-2'
              : 'text-muted hover:bg-surface-2 hover:text-text'
        }`}
      >
        <span className="shrink-0">{section.icon}</span>
        <span className="min-w-0 flex-1 truncate text-left">{section.label}</span>
        <ChevronDown size={14} className={`shrink-0 text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>

      {open && (
        <div id={panelId} className="mt-0.5 ml-[19px] space-y-0.5 border-l border-line pl-2">
          {section.children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              onClick={onNavigate}
              data-nav-current={isLinkActive(child, pathname) ? 'true' : undefined}
              className={`nav-row flex items-center gap-2 rounded-lg px-2.5 py-[7px] text-mini transition-colors ${
                isLinkActive(child, pathname)
                  ? 'text-accent-strong'
                  : 'text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              <span className="shrink-0">{child.icon}</span>
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  // Which sections the user closed. Absent = open, so the default is expanded
  // and the stored value only ever records an explicit collapse.
  const [collapsed, setCollapsed] = usePersistentState<Record<string, boolean>>('nav.collapsed', {});

  // Entering a section reveals it: a collapsed section containing the current
  // page would hide the user's own location. Only fires on route change, so
  // collapsing a section while staying inside it still works.
  useEffect(() => {
    const entering = NAV_SECTIONS.filter((section) =>
      section.children.some((child) => isChildActive(child, pathname)),
    );
    if (entering.length === 0) return;
    setCollapsed((prev) => {
      if (!entering.some((section) => prev[section.label] === true)) return prev;
      const next = { ...prev };
      for (const section of entering) next[section.label] = false;
      return next;
    });
  }, [pathname, setCollapsed]);

  const toggle = useCallback(
    (label: string) => {
      setCollapsed((prev) => ({ ...prev, [label]: !(prev[label] ?? true) }));
    },
    [setCollapsed],
  );

  /*
   * The travelling highlight.
   *
   * One absolutely-positioned element is moved to whichever row carries
   * `data-nav-current`, instead of each row painting its own background. A
   * background can only appear and disappear; a moving element reads as a
   * cursor travelling down a menu, which is the whole point.
   *
   * Measurement is by `offsetTop`/`offsetHeight` against the scrolling list,
   * so it survives the sections nesting, the expanded/collapsed heights and the
   * mobile drawer (a second instance of this component) without any of those
   * needing to know it exists.
   */
  const listRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);
  const [pillReady, setPillReady] = useState(false);
  // `display: none` below `lg` gives the list no box, so a transition started
  // then would never advance. The travel is enabled only while the sidebar is
  // actually laid out.
  const [laidOut, setLaidOut] = useState(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setLaidOut(list.getBoundingClientRect().height > 0);
      const current = list.querySelector<HTMLElement>('[data-nav-current="true"]');
      setPill(current ? { top: current.offsetTop, height: current.offsetHeight } : null);
    };
    measure();
    // Rows move without a route change in two ways, and both are observed above
    // the level of the row itself:
    //   - the window is resized (labels reflow; the type scale is adjustable),
    //   - the sidebar goes from `display: none` (below `lg`) to visible, which is
    //     the case that made the pill measure 0x0 and then stay there, because a
    //     hidden element has no box to measure.
    // A ResizeObserver on the scrolling list catches both without depending on
    // a resize event being delivered.
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    // Opening or closing a section inserts/removes rows and shifts every row
    // below it, without changing the list's own box — a ResizeObserver cannot
    // see that, so the subtree's structure is watched too. Without this the
    // pill stayed on the row above after a section was expanded.
    const mutations = new MutationObserver(measure);
    mutations.observe(list, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [pathname, collapsed]);

  // Enable the travel only after the first measurement, so the pill does not
  // fly in from the top of the sidebar on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setPillReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/40 bg-accent-soft">
          <Activity size={16} className="text-accent" />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">NetPulse</div>
          <div className="text-micro uppercase tracking-[0.18em] text-faint">Network intelligence</div>
        </div>
      </div>
      <div ref={listRef} className="relative flex-1 overflow-y-auto px-3 pb-4">
        <span
          aria-hidden="true"
          className="nav-pill"
          data-visible={pill ? 'true' : 'false'}
          data-ready={pillReady && laidOut ? 'true' : 'false'}
          style={pill ? { transform: `translateY(${pill.top}px)`, height: `${pill.height}px` } : undefined}
        />
        {NAV.map((group) => (
          <div key={group.heading} className="mb-4">
            <div className="px-2 pb-1.5 text-micro font-semibold uppercase tracking-[0.16em] text-faint">
              {group.heading}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) =>
                isSection(item) ? (
                  <NavSectionEntry
                    key={item.label}
                    section={item}
                    pathname={pathname}
                    open={collapsed[item.label] !== true}
                    onToggle={() => toggle(item.label)}
                    onNavigate={onNavigate}
                  />
                ) : (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    data-nav-current={isLinkActive(item, pathname) ? 'true' : undefined}
                    className={linkClass(isLinkActive(item, pathname))}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    {item.label}
                  </NavLink>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}

export function AppShell() {
  const meta = useMeta();
  const { phase, report, error: healthError, refresh, retryAttempt, secondsUntilRetry, runtime } = useStartupHealth();
  useThemeApplier();
  useTypeScaleApplier();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Ctrl/Cmd+Shift+K — connect to a node from whichever page is open. */
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  /**
   * Has the page scrolled away from the top?
   *
   * The header is sticky and translucent, so over a scrolled page it needs to
   * read as a layer rather than as part of the content underneath it. One
   * boolean, read in a passive listener, and set only when it flips — a scroll
   * handler that calls setState per event would re-render the whole shell
   * (sidebar included) on every wheel notch.
   *
   * Deliberately not routed through requestAnimationFrame: a hidden or occluded
   * window starves rAF, so the flag would stick at whatever it was on the last
   * painted frame — including "not scrolled" while the page is scrolled.
   */
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  // Cloud session hydration + the periodic sync loop. Both are no-ops when
  // signed out; the VPN never waits on either.
  const initSession = useCloudSession((s) => s.init);
  useEffect(() => {
    initSession();
    startSyncLoop();
    return stopSyncLoop;
  }, [initSession]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    // The ref, not the state, is what the listener compares against: reading
    // `scrolled` in the closure would need the effect to re-subscribe.
    let last = window.scrollY > 4;
    setScrolled(last);
    const read = () => {
      const next = window.scrollY > 4;
      if (next === last) return;
      last = next;
      setScrolled(next);
    };
    window.addEventListener('scroll', read, { passive: true });
    return () => window.removeEventListener('scroll', read);
  }, []);

  // Ctrl/Cmd + K opens the command palette; Ctrl/Cmd + Shift + K opens quick
  // connect. One handler for both, because `Shift+K` still reports key 'k' —
  // two listeners would have opened the palette underneath the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = overlayShortcut(e);
      if (!target) return;
      e.preventDefault();
      if (target === 'quick-connect') setQuickConnectOpen((v) => !v);
      // With quick connect open, Ctrl+K is ignored rather than stacking the
      // palette on top of it: two dialogs at once have no obvious Escape.
      else if (!quickConnectOpen) setPaletteOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quickConnectOpen]);

  const closeQuickConnect = useCallback(() => setQuickConnectOpen(false), []);
  /** From the palette: the overlay replaces it, so a keystroke never leaves two dialogs stacked. */
  const openQuickConnect = useCallback(() => {
    setPaletteOpen(false);
    setQuickConnectOpen(true);
  }, []);

  return (
    <div className="app-backdrop flex min-h-screen">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-surface/80 backdrop-blur lg:block">
        <SidebarContent />
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="drawer-backdrop-in absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="drawer-panel-in absolute inset-y-0 left-0 w-64 border-r border-line bg-surface">
            <button
              className="absolute right-3 top-4 rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X size={18} />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        {/* topbar */}
        <header
          data-scrolled={scrolled ? 'true' : 'false'}
          className={`sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b bg-bg/80 px-4 backdrop-blur transition-[box-shadow,border-color] duration-200 lg:px-8 ${
            scrolled ? 'border-line-strong shadow-floating' : 'border-line shadow-raised'
          }`}
        >
          <div className="flex items-center gap-3">
            <button
              className="rounded-lg border border-line bg-surface-2 p-2 text-muted lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={16} />
            </button>
            <span className="hidden text-xs text-faint sm:block">
              Local network diagnostics workspace
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              className="flex h-8 items-center gap-2 rounded-full border border-line bg-surface px-3 text-xs text-muted hover:bg-surface-2 hover:text-text"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search size={13} />
              <span className="hidden sm:inline">Commands</span>
              <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-micro text-faint">Ctrl K</kbd>
            </button>
            <button
              className="flex h-8 items-center gap-2 rounded-full border border-line bg-surface px-3 text-xs text-muted hover:bg-surface-2 hover:text-text"
              onClick={() => setQuickConnectOpen(true)}
              aria-label="Quick connect to a node"
              title="Connect to a tested node without leaving this page"
            >
              <Zap size={13} />
              <span className="hidden sm:inline">Connect</span>
              <kbd className="hidden rounded border border-line bg-surface-2 px-1 font-mono text-micro text-faint md:inline">
                Ctrl ⇧ K
              </kbd>
            </button>
            {meta?.demoMode && <DemoBadge />}
            <NavLink
              to="/health"
              className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
            >
              <StatusDot
                tone={
                  phase === 'ready' ? 'ok' : phase === 'degraded' ? 'warn' : phase === 'recovery' ? 'danger' : 'idle'
                }
                pulse={phase !== 'ready'}
              />
              {phase === 'ready'
                ? 'Ready'
                : phase === 'degraded'
                  ? 'Degraded'
                  : phase === 'recovery'
                    ? 'Recovery Required'
                    : phase === 'checking'
                      ? 'Checking…'
                      : 'Starting…'}
            </NavLink>
          </div>
        </header>

        {/* Update surface: silent until the feed reports a real version. */}
        <UpdateBanner />

        {meta?.safeMode && (
          <div className="flex items-center justify-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
            <TriangleAlert size={13} className="shrink-0" />
            <span>
              Safe Mode is active — networking, VPN and scanners are disabled.
              Exit Safe Mode in Settings after repairing your installation.
            </span>
            <NavLink to="/settings" className="shrink-0 underline underline-offset-2 hover:opacity-80">
              Open Settings
            </NavLink>
          </div>
        )}

        {phase === 'recovery' && !meta?.safeMode && (
          <div className="flex items-center justify-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
            <Loader2 size={13} className="shrink-0 animate-spin" />
            <span>
              Backend unreachable — reconnecting
              {typeof secondsUntilRetry === 'number'
                ? secondsUntilRetry > 0
                  ? ` in ${secondsUntilRetry}s`
                  : ' now'
                : ''}
              {retryAttempt > 1 ? ` (attempt ${retryAttempt})` : ''}. The app keeps running; diagnostics and recovery
              actions are available.
              {runtime?.last_restart_reason ? (
                <span className="block max-w-3xl whitespace-pre-wrap text-micro opacity-80">
                  Last sidecar failure: {runtime.last_restart_reason.split('\n')[0]?.slice(0, 200)}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              className="shrink-0 rounded border border-danger/40 px-1.5 py-0.5 font-medium hover:bg-danger/10"
            >
              Retry now
            </button>
            <NavLink to="/health" className="shrink-0 underline underline-offset-2 hover:opacity-80">
              Open System Health
            </NavLink>
          </div>
        )}

        {phase === 'degraded' && !meta?.safeMode && (
          <div className="flex items-center justify-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
            <TriangleAlert size={13} className="shrink-0" />
            <span>
              {(() => {
                const bad = (report?.checks ?? []).filter((c) => c && c.state !== 'ok' && typeof c.label === 'string');
                if (bad.length === 0) {
                  // Degraded without a named component: show the hook's error
                  // (e.g. malformed report) instead of a nonsensical "0".
                  return healthError ?? 'Some components need attention — open System Health for details.';
                }
                return bad.length === 1
                  ? `${bad[0]!.label}: ${bad[0]!.detail}`
                  : `${bad.length} components degraded: ${bad.map((c) => c.label).join(', ')}`;
              })()}
            </span>
            <NavLink to="/health" className="shrink-0 underline underline-offset-2 hover:opacity-80">
              Details &amp; actions
            </NavLink>
          </div>
        )}

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8 lg:py-8">
          {/* Pages are lazy routes (see router.tsx). The boundary sits inside
              the shell on purpose: the sidebar and header stay mounted while a
              page chunk downloads, so navigation never blanks the window.

              The key is on the animated wrapper, not on the boundary: a new
              pathname mounts a new wrapper, which re-runs the `page-enter`
              animation. The fallback renders OUTSIDE that wrapper so its fixed
              progress rail is measured against the window — a transform on an
              ancestor would make the rail position itself against the page. */}
          <Suspense fallback={<PageSkeleton />}>
            <div key={location.pathname} className="page-enter">
              <Outlet />
            </div>
          </Suspense>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onQuickConnect={openQuickConnect}
      />
      <QuickConnectOverlay open={quickConnectOpen} onClose={closeQuickConnect} />
    </div>
  );
}
