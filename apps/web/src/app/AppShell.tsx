import { useEffect, useState } from 'react';

import {
  Activity,
  Cloud,
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
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { CommandPalette } from '@/components/CommandPalette';
import { useStartupHealth } from '@/lib/useStartupHealth';
import { DemoBadge } from '@/components/ui/Badge';
import { StatusDot } from '@/components/ui/StatusDot';
import { api } from '@/lib/api';
import { useThemeApplier } from '@/app/useTheme';

import type { ReactNode } from 'react';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
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
      { to: '/nodes', label: 'Node Explorer', icon: <Radar size={16} /> },
      { to: '/nodes-sources', label: 'Node Sources', icon: <Download size={16} /> },
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
    items: [{ to: '/settings', label: 'Settings', icon: <Settings size={16} /> }],
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

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/40 bg-accent-soft">
          <Activity size={16} className="text-accent" />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">NetPulse</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-faint">Network intelligence</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {NAV.map((group) => (
          <div key={group.heading} className="mb-4">
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
              {group.heading}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-accent-soft text-accent-strong'
                        : 'text-muted hover:bg-surface-2 hover:text-text'
                    }`
                  }
                >
                  <span className="shrink-0">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Ctrl/Cmd + K opens the command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface">
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
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur lg:px-8">
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
              <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-faint">Ctrl K</kbd>
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
                <span className="block max-w-3xl whitespace-pre-wrap text-[11px] opacity-80">
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
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
