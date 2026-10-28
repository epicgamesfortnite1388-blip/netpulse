import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownLeft, Loader2, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { StatusDot } from '@/components/ui/StatusDot';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { filterQuickNodes, quickNodeMeta, stepActive, type QuickNode } from '@/lib/quickConnect';
import { tunnelStartMessage } from '@/features/nodes/nodeActionPolicy';

import type { ProxyTunnelStatus } from '@netpulse/shared';

/**
 * Quick connect (Ctrl/Cmd+Shift+K) — pick a tested node and connect to it
 * without leaving the page you are on.
 *
 * Why an overlay and not a page: the tunnel is a machine-wide action, so the
 * page you happen to be reading is irrelevant to it. Sending the user to VPN →
 * Proxy tunnel to start it, then back, is a navigation tax for a single POST.
 *
 * Three rules this overlay keeps:
 *   - It only lists candidates the backend would accept: the same
 *     tested-healthy query the tunnel card uses, sorted by measured proxy
 *     latency. A node without a recent successful proxy test is not shown as
 *     pickable, because the start route refuses it.
 *   - The toast is built from the tunnel the server STORED (`tunnelStartMessage`),
 *     so "connected" only appears once an exit IP was observed through the node.
 *   - A failed start keeps the overlay open with the server's reason, so the
 *     next attempt is one keystroke away instead of a reopened dialog.
 *
 * Keyboard: ↑/↓ move, ↵ connects, esc closes. The list is driven by the input,
 * so there is no second tab stop to hunt for — except Disconnect while a tunnel
 * is live.
 */
export function QuickConnectOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Where focus came from, so closing returns it to the button that opened this. */
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Same cache keys as the VPN tunnel card: opening either surface reuses the
  // candidates the other already fetched, and a connect invalidates both.
  const candidatesQuery = useQuery({
    queryKey: ['tunnel', 'candidates'],
    queryFn: () =>
      api.get<{ nodes: QuickNode[] }>('/nodes?limit=50&sortField=proxyLatency&sortDir=asc&maxLatency=5000'),
    enabled: open,
    staleTime: 30_000,
  });

  const statusQuery = useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: () => api.get<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/status'),
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });

  const allNodes = useMemo(() => candidatesQuery.data?.nodes ?? [], [candidatesQuery.data]);
  const nodes = useMemo(() => filterQuickNodes(allNodes, query), [allNodes, query]);

  const connect = useMutation({
    mutationFn: (node: QuickNode) =>
      api.post<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/start', { nodeId: node.id, systemProxy: true }),
    onMutate: (node) => {
      setConnectingId(node.id);
      setError(null);
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      const message = tunnelStartMessage(data.tunnel);
      toast(message.tone, message.title, message.body);
      // Only a verified tunnel earns a closed dialog. Anything else stays open
      // with the reason, so the user can pick a different node immediately.
      if (data.tunnel.state === 'active') onClose();
      else setError(message.body ?? message.title);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not start the tunnel');
    },
    onSettled: () => {
      setConnectingId(null);
      // A failed start reopens the picker for the next node; the keyboard must
      // still be on the list, not dropped on the page behind the dialog.
      inputRef.current?.focus();
    },
  });

  const stop = useMutation({
    mutationFn: () => api.post<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/stop'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      toast('ok', 'Tunnel stopped', 'System proxy restored.');
    },
    onError: (err) => toast('error', 'Stop failed', err instanceof Error ? err.message : undefined),
  });

  // Reset per opening, and hand focus back to whatever opened the overlay.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setError(null);
    setConnectingId(null);
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The input owns the keyboard, so it must hold focus for the whole time the
    // dialog is open — including after a mouse click, which native focus would
    // otherwise hand to the clicked row and strand ↑/↓/↵ on a dead body.
    inputRef.current?.focus();
    return () => {
      restoreFocus.current?.focus?.();
    };
  }, [open]);

  // Escape from anywhere in the dialog, including the Disconnect button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A filter that shortens the list must not leave the selection past the end.
  useEffect(() => {
    setActive((a) => (nodes.length === 0 ? 0 : Math.min(a, nodes.length - 1)));
  }, [nodes.length]);

  // Keep the selected row visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-quick-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, nodes.length]);

  if (!open) return null;

  const tunnel = statusQuery.data?.tunnel ?? null;
  const tunnelLive = tunnel !== null && tunnel.state !== 'idle';
  const tunnelBusy = tunnel?.state === 'starting' || tunnel?.state === 'stopping';
  const connectedName =
    tunnel?.nodeName ?? (tunnel?.nodeId ? allNodes.find((n) => n.id === tunnel.nodeId)?.label : null) ?? tunnel?.nodeId ?? null;
  const tone =
    tunnel === null || tunnel.state === 'idle'
      ? 'idle'
      : tunnel.state === 'active'
        ? 'ok'
        : tunnel.state === 'down'
          ? 'danger'
          : 'warn';

  const choose = (node: QuickNode | undefined) => {
    if (!node || connect.isPending) return;
    connect.mutate(node);
  };

  return (
    <div
      className="palette-backdrop-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick connect"
        className="palette-panel-in w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-overlay"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-connect-list"
            aria-autocomplete="list"
            aria-activedescendant={nodes[active] ? `quick-node-${active}` : undefined}
            aria-label="Connect to a node"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            placeholder="Connect to a node…"
            value={query}
            // Deliberately NOT disabled while connecting: disabling the focused
            // input moves focus to <body>, and a failed attempt would then need
            // a mouse click before Enter could retry. `choose` is the guard.
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => stepActive(a, nodes.length, 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => stepActive(a, nodes.length, -1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(nodes[active]);
              }
            }}
          />
          <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-micro text-faint">ESC</kbd>
        </div>

        {/* What the machine is currently routed through. Rendered only from the
            status the server holds — never from what this overlay last sent. */}
        {tunnelLive && (
          <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2 text-xs">
            <StatusDot tone={tone} pulse={tunnelBusy} />
            <span className="min-w-0 flex-1 truncate text-muted">
              {tunnel.state === 'starting' ? (
                <>Connecting to <span className="text-text">{connectedName ?? 'a node'}</span>…</>
              ) : tunnel.state === 'stopping' ? (
                <>Stopping the tunnel…</>
              ) : tunnel.state === 'down' ? (
                <>
                  Tunnel down
                  {connectedName ? <span className="text-text"> · {connectedName}</span> : null}
                  {tunnel.error ? <span className="text-danger"> — {tunnel.error}</span> : null}
                </>
              ) : (
                <>
                  Connected via <span className="text-text">{connectedName ?? 'a node'}</span>
                  <span className="text-faint">
                    {' '}
                    · {tunnel.exitIp ? `exit ${tunnel.exitIp}${tunnel.exitCountry ? ` (${tunnel.exitCountry})` : ''}` : '                exit unverified'}
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              // Keep the keyboard in the search field: a mouse click here must
              // not strand the next ↑/↓/↵ on the page behind the dialog.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => stop.mutate()}
              disabled={stop.isPending || tunnelBusy}
              className="shrink-0 rounded border border-danger/40 px-1.5 py-0.5 font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        )}

        <ul
          ref={listRef}
          id="quick-connect-list"
          role="listbox"
          aria-label="Tested nodes"
          className="max-h-[min(58vh,26rem)] overflow-y-auto p-1.5"
        >
          {candidatesQuery.isLoading && (
            <li className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-faint">
              <Loader2 size={13} className="animate-spin" /> Loading tested nodes…
            </li>
          )}
          {!candidatesQuery.isLoading && allNodes.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-faint">
              No tested nodes yet. Run a proxy test in the Node Explorer first — only a node with a recent successful
              proxy test can carry a tunnel.
            </li>
          )}
          {!candidatesQuery.isLoading && allNodes.length > 0 && nodes.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-faint">No node matches “{query.trim()}”.</li>
          )}
          {nodes.map((node, i) => (
            <li
              key={node.id}
              id={`quick-node-${i}`}
              data-quick-index={i}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              // Same rule as Disconnect: the click connects, the focus stays put.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(node)}
              className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${
                i === active ? 'bg-accent-soft' : 'hover:bg-surface-2'
              } ${connect.isPending && connectingId !== node.id ? 'opacity-60' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm ${i === active ? 'text-accent-strong' : 'text-text'}`}>
                  {node.label}
                </span>
                <span className="block truncate text-micro text-faint">{quickNodeMeta(node)}</span>
              </span>
              <Badge tone="neutral">{node.protocol}</Badge>
              {connectingId === node.id ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
              ) : (
                i === active && <CornerDownLeft size={13} className="shrink-0 text-faint" />
              )}
            </li>
          ))}
        </ul>

        {/* The server's own refusal, kept on screen: re-picking is the fix, and
            it must not require reopening the dialog to read why. */}
        {(error || candidatesQuery.isError) && (
          <p role="alert" className="border-t border-danger/30 bg-danger/10 px-4 py-2 text-xs leading-relaxed text-danger">
            {error ?? (candidatesQuery.error instanceof Error ? candidatesQuery.error.message : 'Could not load nodes')}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-micro text-faint">
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">↑↓</kbd>
            move
            <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">↵</kbd>
            connect
            <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">esc</kbd>
            close
          </span>
          <span className="truncate">
            {allNodes.length > 0 ? `${nodes.length} of ${allNodes.length} tested nodes` : 'tested nodes only'} · system
            proxy on
          </span>
        </div>
      </div>
    </div>
  );
}
