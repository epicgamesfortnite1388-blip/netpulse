import { useEffect, useMemo, useRef, useState } from 'react';

import { useNavigate } from 'react-router';

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

/**
 * Keyboard-accessible command palette (Ctrl/Cmd+K). Navigating to a route is
 * the only action — long-running tests are launched from their pages so real
 * progress and results stay visible.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    return [
      { id: 'dashboard', label: 'Open dashboard', hint: '', run: go('/') },
      { id: 'live-map', label: 'Open live map', hint: 'Live Map', run: go('/map') },
      { id: 'map-cloudflare', label: 'Measure nearest Cloudflare', hint: 'Live Map', run: go('/map?target=cloudflare:speed&run=1') },
      { id: 'map-dns', label: 'Show DNS map', hint: 'Live Map', run: go('/map?mode=dns') },
      { id: 'map-gaming', label: 'Show gaming map', hint: 'Live Map', run: go('/map?mode=gaming') },
      { id: 'map-route', label: 'Show current route', hint: 'Live Map', run: go('/map?mode=route') },
      { id: 'map-connections', label: 'Show active connections', hint: 'Live Map', run: go('/map?connections=1') },
      { id: 'quick-check', label: 'Run complete diagnostic', hint: 'Quick Check', run: go('/diagnostics') },
      { id: 'speed', label: 'Run speed test', hint: 'Speed Test', run: go('/speed-test') },
      { id: 'dns', label: 'Benchmark DNS', hint: 'DNS Lab', run: go('/dns?run=1') },
      { id: 'gaming', label: 'Open gaming', hint: 'Gaming', run: go('/gaming') },
      { id: 'iran', label: 'Open Iran Connectivity', hint: 'Iran', run: go('/iran') },
      { id: 'iran-run', label: 'Run Iran connectivity test', hint: 'Iran', run: go('/iran?run=1') },
      { id: 'iran-vpn', label: 'Compare direct vs VPN for Iran', hint: 'Iran', run: go('/iran?tab=vpn') },
      { id: 'iran-recs', label: 'Show Iran recommendations', hint: 'Iran', run: go('/iran?tab=recommendations') },
      { id: 'gaming-valorant', label: 'Check VALORANT regions', hint: 'Gaming', run: go('/gaming?game=valorant&run=1') },
      { id: 'gaming-cs2', label: 'Check CS2', hint: 'Gaming', run: go('/gaming?game=cs2&run=1') },
      { id: 'gaming-roblox', label: 'Check Roblox', hint: 'Gaming', run: go('/gaming?game=roblox&run=1') },
      { id: 'gaming-fortnite', label: 'Check Fortnite', hint: 'Gaming', run: go('/gaming?game=fortnite&run=1') },
      { id: 'ip', label: 'Check IP', hint: 'IP Intelligence', run: go('/ip') },
      { id: 'route', label: 'Check route', hint: 'Route checker', run: go('/routes') },
      { id: 'scan', label: 'Scan Cloudflare', hint: 'Cloudflare endpoints', run: go('/cloudflare') },
      { id: 'optimize', label: 'Optimize connection', hint: 'Optimizer', run: go('/optimizer') },
      { id: 'servers', label: 'Manage servers', hint: 'Servers', run: go('/servers') },
      { id: 'nodes', label: 'Browse nodes', hint: 'Node Explorer', run: go('/nodes') },
      { id: 'nodes-sources', label: 'Manage node sources & scanning', hint: 'Node Sources', run: go('/nodes-sources') },
      { id: 'vpn', label: 'VPN center', hint: 'VPN', run: go('/vpn') },
      { id: 'history', label: 'View history', hint: 'History', run: go('/history') },
      { id: 'events', label: 'Open event log', hint: 'Events', run: go('/events') },
      { id: 'settings', label: 'Open settings', hint: 'Settings', run: go('/settings') },
    ];
  }, [navigate, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-overlay">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <span className="text-muted">⌕</span>
          <input
            autoFocus
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                filtered[active]?.run();
              }
            }}
            aria-label="Command palette"
          />
          <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-micro text-faint">
            ESC
          </kbd>
        </div>
        <ul ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-faint">No matching commands</li>
          )}
          {filtered.map((cmd, i) => (
            <li key={cmd.id}>
              <button
                ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${
                  i === active ? 'bg-accent-soft text-accent-strong' : 'text-text hover:bg-surface-2'
                }`}
                onClick={cmd.run}
                onMouseEnter={() => setActive(i)}
              >
                <span>{cmd.label}</span>
                {cmd.hint && <span className="text-micro text-faint">{cmd.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
