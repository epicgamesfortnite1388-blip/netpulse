import { Suspense, useCallback, useEffect, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Loader2,
  Menu,
  Moon,
  Search,
  Sun,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { CommandPalette } from '@/components/CommandPalette';
import { GlobalConnectionChip } from '@/components/GlobalConnectionChip';
import { PulseMark } from '@/components/PulseMark';
import { QuickConnectOverlay } from '@/components/QuickConnectOverlay';
import { useToast } from '@/components/Toaster';
import { DemoBadge } from '@/components/ui/Badge';
import { PageSkeleton } from '@/components/ui/States';
import { StatusDot } from '@/components/ui/StatusDot';
import { UpdateBanner } from '@/features/settings/UpdateBanner';
import { QUICK_CONNECT_EVENT } from '@/features/connection/connectionState';
import { startSyncLoop, stopSyncLoop } from '@/lib/cloud/syncEngine';
import { useCloudSession } from '@/lib/cloud/useCloudSession';
import { api } from '@/lib/api';
import { overlayShortcut } from '@/lib/quickConnect';
import { useStartupHealth } from '@/lib/useStartupHealth';
import { useThemeApplier } from '@/app/useTheme';
import { useTypeScaleApplier } from '@/app/useTypeScale';
import { groupedLinks, isCurrentLink, resolveSection, SECTIONS } from './nav';

import type { AppSettings, ThemeSetting } from '@shared/models/settings';
import type { NavSection } from './nav';

interface Meta {
  demoMode: boolean;
  safeMode?: boolean;
}

function useMeta() {
  // Failure degrades to "backend offline"; the recovery banner below surfaces
  // that honestly instead of faking a Ready state.
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    api
      .get<Meta>('/meta')
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);
  return meta;
}

function currentTitle(pathname: string, section: NavSection): string {
  const link = section.links.find((l) => isCurrentLink(l.to, pathname));
  if (link) return link.label;
  if (pathname.startsWith('/nodes/')) return 'Node detail';
  if (pathname === '/') return 'Dashboard';
  return 'Page not found';
}

/** Rail: five capability destinations. The active marker is a vertical signal
 *  bar, not a floating pill — it reads as an instrument channel indicator. */
function Rail({ pathname }: { pathname: string }) {
  const active = resolveSection(pathname).id;
  return (
    <aside className="np-rail" aria-label="Primary navigation">
      <div className="flex h-[var(--np-topbar-h)] w-full items-center justify-center border-b border-line">
        <PulseMark size={32} />
      </div>
      <nav className="flex w-full flex-1 flex-col pt-3">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <NavLink
              key={section.id}
              to={section.to}
              className="np-rail-item"
              data-active={active === section.id ? 'true' : 'false'}
              aria-current={active === section.id ? 'page' : undefined}
              title={section.label}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{section.railLabel}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="flex w-full flex-col items-center gap-2 border-t border-line py-3">
        <span className="np-label">3.2</span>
      </div>
    </aside>
  );
}

/** Context column: only the active section's routes. Grouped, never scrolled
 *  behind eight unrelated headings. */
function ContextColumn({ pathname }: { pathname: string }) {
  const section = resolveSection(pathname);
  return (
    <aside className="np-context" aria-label={`${section.label} navigation`}>
      <div className="px-2 pb-5">
        <div className="np-label">{section.label}</div>
        <p className="mt-1.5 text-micro leading-relaxed text-faint">{section.blurb}</p>
      </div>
      {groupedLinks(section).map((group) => (
        <div key={group.group} className="mb-5">
          <div className="np-section-head px-2">
            <span className="np-label">{group.group}</span>
          </div>
          <div className="space-y-0.5">
            {group.links.map((link) => {
              const Icon = link.icon;
              return (
                <NavLink
                  key={link.to}
                  to={link.to}
                  className="np-context-link"
                  data-active={isCurrentLink(link.to, pathname) ? 'true' : 'false'}
                  aria-current={isCurrentLink(link.to, pathname) ? 'page' : undefined}
                >
                  <Icon size={14} strokeWidth={1.7} className="shrink-0 opacity-75" />
                  <span className="min-w-0 flex-1 truncate">{link.label}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
}

/** Below 1024px the two columns collapse into one drawer containing every
 *  destination, so no feature becomes unreachable on a narrow window. */
function MobileNav({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  return (
    <div className="np-mobile-nav lg:hidden">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} aria-hidden="true" />
      <div className="np-mobile-panel drawer-panel-in">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <PulseMark size={30} />
            <div>
              <div className="text-sm font-semibold tracking-tight">NetPulse</div>
              <div className="np-label">Network intelligence</div>
            </div>
          </div>
          <button className="np-icon-btn" onClick={onClose} aria-label="Close navigation">
            <X size={17} />
          </button>
        </div>
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <div key={section.id} className="mb-5">
              <div className="np-section-head">
                <Icon size={13} className="text-faint" />
                <span className="np-label">{section.label}</span>
              </div>
              <div className="space-y-0.5">
                {section.links.map((link) => {
                  const LinkIcon = link.icon;
                  return (
                    <NavLink
                      key={link.to}
                      to={link.to}
                      onClick={onClose}
                      className="np-context-link"
                      data-active={isCurrentLink(link.to, pathname) ? 'true' : 'false'}
                    >
                      <LinkIcon size={14} className="shrink-0 opacity-75" />
                      {link.label}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Theme toggle writes the same `general` settings section the Settings page
 *  saves, then invalidates the shared cache so useThemeApplier re-applies it. */
function useThemeToggle() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: AppSettings }>('/settings'),
    staleTime: 30_000,
  });
  const theme: ThemeSetting = data?.settings?.general?.theme ?? 'dark';
  const isLight = theme === 'light' || (theme === 'system' && document.documentElement.dataset.theme === 'light');
  const [saving, setSaving] = useState(false);

  const toggle = useCallback(async () => {
    const general = data?.settings?.general;
    if (!general || saving) return;
    const next: ThemeSetting = isLight ? 'dark' : 'light';
    setSaving(true);
    try {
      await api.put('/settings', { general: { ...general, theme: next } });
      await qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      toast('error', 'Could not change theme', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }, [data, isLight, saving, qc, toast]);

  return { isLight, toggle, saving };
}

export function AppShell() {
  const meta = useMeta();
  const { phase, report, error: healthError, refresh, retryAttempt, secondsUntilRetry, runtime } = useStartupHealth();
  useThemeApplier();
  useTypeScaleApplier();
  const themeToggle = useThemeToggle();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Ctrl/Cmd+Shift+K — connect to a node from whichever page is open. */
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const pathname = location.pathname;
  const section = resolveSection(pathname);

  // Cloud session hydration + periodic sync. Both are no-ops when signed out;
  // the VPN never waits on either.
  const initSession = useCloudSession((s) => s.init);
  useEffect(() => {
    initSession();
    startSyncLoop();
    return stopSyncLoop;
  }, [initSession]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Passive scroll listener with a local flag: setState fires only when the
  // boolean flips, so one wheel notch does not re-render the shell.
  useEffect(() => {
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

  // One handler for both shortcuts: Shift+K still reports key 'k', so two
  // listeners would stack the palette underneath the connect overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = overlayShortcut(e);
      if (!target) return;
      e.preventDefault();
      if (target === 'quick-connect') setQuickConnectOpen((v) => !v);
      else if (!quickConnectOpen) setPaletteOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quickConnectOpen]);

  // Any screen (dashboard hero, empty states) can request the connect overlay
  // without the shell threading state into every page.
  useEffect(() => {
    const open = () => {
      setPaletteOpen(false);
      setQuickConnectOpen(true);
    };
    window.addEventListener(QUICK_CONNECT_EVENT, open);
    return () => window.removeEventListener(QUICK_CONNECT_EVENT, open);
  }, []);

  const closeQuickConnect = useCallback(() => setQuickConnectOpen(false), []);
  const openQuickConnect = useCallback(() => {
    setPaletteOpen(false);
    setQuickConnectOpen(true);
  }, []);

  return (
    <div className="np-shell flex min-h-screen">
      {/* WCAG 2.4.1: keyboard users can jump the 25-link navigation block.
          Off-screen until focused, then pinned to the top-left corner. */}
      <a
        href="#np-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-on-accent focus:shadow-overlay"
      >
        Skip to main content
      </a>
      <Rail pathname={pathname} />
      <ContextColumn pathname={pathname} />
      {mobileOpen && <MobileNav pathname={pathname} onClose={() => setMobileOpen(false)} />}

      <div className="np-shell-body flex min-w-0 flex-1 flex-col">
        <header className="np-topbar" data-scrolled={scrolled ? 'true' : 'false'}>
          <div className="flex min-w-0 items-center gap-3">
            <button
              className="np-icon-btn lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={18} />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden truncate text-faint sm:inline">{section.label}</span>
              <ChevronRight size={13} className="hidden shrink-0 text-faint sm:inline" />
              <span className="truncate font-semibold text-text">{currentTitle(pathname, section)}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <GlobalConnectionChip />
            <button
              className="np-icon-btn"
              onClick={() => void themeToggle.toggle()}
              disabled={themeToggle.saving}
              aria-label={themeToggle.isLight ? 'Switch to dark theme' : 'Switch to light theme'}
              title={themeToggle.isLight ? 'Switch to dark theme' : 'Switch to light theme'}
            >
              {themeToggle.isLight ? <Moon size={16} /> : <Sun size={16} />}
            </button>
            <button
              className="np-btn-quiet hidden sm:inline-flex"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search size={13} />
              <span className="hidden md:inline">Commands</span>
              <kbd className="hidden rounded border border-line bg-surface px-1 font-mono text-micro text-faint lg:inline">
                Ctrl K
              </kbd>
            </button>
            <button
              className="np-btn-quiet"
              onClick={() => setQuickConnectOpen(true)}
              aria-label="Quick connect to a node"
              title="Connect to a tested node without leaving this page"
            >
              <Zap size={13} />
              <span className="hidden md:inline">Connect</span>
            </button>
            {meta?.demoMode && <DemoBadge />}
            <NavLink to="/health" className="np-btn-quiet hidden lg:inline-flex" title="Backend health">
              <StatusDot
                tone={phase === 'ready' ? 'ok' : phase === 'degraded' ? 'warn' : phase === 'recovery' ? 'danger' : 'idle'}
                pulse={phase !== 'ready'}
              />
              {phase === 'ready'
                ? 'Ready'
                : phase === 'degraded'
                  ? 'Degraded'
                  : phase === 'recovery'
                    ? 'Recovery'
                    : phase === 'checking'
                      ? 'Checking…'
                      : 'Starting…'}
            </NavLink>
          </div>
        </header>

        {/* Global surfaces: silent until the backend actually reports something. */}
        <UpdateBanner />

        {meta?.safeMode && (
          <div className="flex items-center justify-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
            <TriangleAlert size={13} className="shrink-0" />
            <span>
              Safe Mode is active — networking, VPN and scanners are disabled. Exit Safe Mode in Settings after repairing
              your installation.
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
                if (bad.length === 0) return healthError ?? 'Some components need attention — open System Health for details.';
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

        <main id="np-main" tabIndex={-1} className="np-content flex-1 outline-none">
          {/* The boundary sits inside the shell so navigation never blanks the
              window. The key re-runs page-enter on a pathname change; the
              fallback renders outside the animated wrapper so its fixed
              progress rail measures against the window. */}
          <Suspense fallback={<PageSkeleton />}>
            <div key={pathname} className="page-enter">
              <Outlet />
            </div>
          </Suspense>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onQuickConnect={openQuickConnect} />
      <QuickConnectOverlay open={quickConnectOpen} onClose={closeQuickConnect} />
    </div>
  );
}
