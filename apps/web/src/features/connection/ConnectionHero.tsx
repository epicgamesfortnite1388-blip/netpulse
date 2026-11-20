/**
 * The primary connection console. Every value on this panel is read from the
 * backend carriers in connectionState.ts; the only local state is whether a
 * disconnect mutation is in flight. There is no progress percentage, no
 * synthetic latency, no invented server and no optimistic "connected" state.
 */
import { ArrowUpRight, Loader2, PlugZap, Power, TriangleAlert } from 'lucide-react';
import { useNavigate } from 'react-router';

import { ConnectionDial } from './ConnectionDial';
import { requestQuickConnect, TONE_VAR, useDisconnect } from './connectionState';
import { timeAgo } from '@/lib/format';

import type { CSSProperties } from 'react';
import type { ConnectionPresentation } from './connectionState';

function fmtBytes(v: number | null): string {
  if (v == null) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * A session fact as a stacked readout: label above, value below.
 *
 * The side-by-side row needed ~200px to keep "not verified" on one line; in the
 * panel's narrower column it wrapped every long value onto two lines and made
 * the block taller than the list it replaced. Stacking halves the width a value
 * needs and reads as a gauge block rather than a table.
 */
function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="np-label">{label}</div>
      <div className="np-row-value truncate">{value}</div>
    </div>
  );
}

export function ConnectionHero({ state }: { state: ConnectionPresentation }) {
  const navigate = useNavigate();
  const disconnect = useDisconnect();
  const tone = TONE_VAR[state.tone];
  const busy =
    state.state === 'connecting' ||
    state.state === 'reconnecting' ||
    state.state === 'disconnecting' ||
    disconnect.isPending;

  const onPrimary = () => {
    if (state.canDisconnect) {
      disconnect.mutate(state.source);
      return;
    }
    if (state.canConnect) {
      requestQuickConnect();
    }
  };

  return (
    <section className="np-panel @container overflow-hidden" aria-labelledby="np-connection-heading">
      <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
        <span className="np-label">Primary connection</span>
        <span
          className="np-state-badge"
          style={{ '--np-state': tone } as CSSProperties}
          role="status"
          aria-live="polite"
        >
          <span className="np-state-dot" />
          {state.short}
        </span>
      </div>

      {/* Container queries, not viewport breakpoints: this panel lives in a
          column whose width depends on the page, so `lg:` claimed there was
          room for 236px + 258px while the panel itself had ~430px — the verdict
          text collapsed to a 40px sliver and the session column hung off the
          edge at 1024px.

          The dial spans both rows once there is room, so the verdict and the
          session facts share the right-hand column. The earlier three-across
          arrangement needed ~570px of fixed width and only ever fitted at one
          window size; this one is 150px shorter and never breaks. */}
      <div className="grid gap-6 px-6 py-6 @[480px]:grid-cols-[auto_minmax(0,1fr)] @[480px]:items-start @[480px]:gap-x-8">
        {/* Dial: three real signals, no idle animation. */}
        <div className="flex items-start justify-center @[480px]:row-span-2 @[480px]:justify-start">
          <ConnectionDial state={state} />
        </div>

        {/* Verdict + actions. */}
        <div className="flex min-w-0 flex-col justify-center">
          <h2
            id="np-connection-heading"
            className="text-3xl font-semibold leading-tight tracking-tight"
            style={{ color: tone }}
          >
            {state.label}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{state.detail}</p>

          {state.warnings.length > 0 && (
            <ul className="mt-4 space-y-1.5" aria-label="Connection cautions">
              {state.warnings.slice(0, 3).map((w, i) => (
                <li key={`${i}-${w}`} className="flex items-start gap-2 text-xs leading-relaxed text-warn">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            {state.canDisconnect ? (
              <button className="np-btn-quiet" onClick={onPrimary} disabled={disconnect.isPending}>
                {disconnect.isPending ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                Disconnect
              </button>
            ) : (
              <button className="np-btn-primary" onClick={onPrimary} disabled={!state.canConnect || busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
                {state.state === 'error' ? 'Try again' : busy ? 'In progress' : 'Connect'}
              </button>
            )}
            <button className="np-btn-quiet" onClick={() => navigate(state.source === 'proxy-tunnel' ? '/vpn' : '/nodes')}>
              {state.source === 'proxy-tunnel' ? 'Connection details' : 'Choose a node'}
              <ArrowUpRight size={13} />
            </button>
          </div>

          {/* Transitions are reported by the backend. Explicitly saying so is
              more honest than a fabricated progress bar. */}
          {busy && !disconnect.isPending && (
            <p className="mt-3 font-mono text-micro text-faint">
              Waiting for backend state transition — no progress is estimated.
            </p>
          )}
          {disconnect.isError && (
            <p className="mt-3 text-xs text-danger">
              Disconnect failed: {disconnect.error instanceof Error ? disconnect.error.message : 'unknown error'}
            </p>
          )}
        </div>

        {/* Real connection facts. A dash means "not reported", never a guess.
            Tone, not a second border: this block already sits inside a panel. */}
        <div className="@container rounded-[var(--np-r-2)] bg-surface-2/60 px-4 py-3 @[480px]:col-start-2">
          <div className="np-label mb-2">Session detail</div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 @[300px]:grid-cols-2">
            <DetailCell label="Server" value={state.serverName ?? '—'} />
            <DetailCell label="Engine" value={state.engine ?? '—'} />
            <DetailCell label="Protocol" value={state.protocol ?? '—'} />
            <DetailCell label="Exit IP" value={state.exitIp ?? 'not verified'} />
            <DetailCell label="Connected" value={state.since ? timeAgo(state.since) : '—'} />
            <DetailCell label="Latency" value={state.latencyMs != null ? `${state.latencyMs} ms` : 'not measured'} />
            <DetailCell label="Received" value={fmtBytes(state.rxBytes)} />
            <DetailCell label="Sent" value={fmtBytes(state.txBytes)} />
          </div>
        </div>
      </div>

      <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
        {[
          { label: 'Tunnel', value: state.dial.tunnel >= 1 ? 'Established' : state.dial.tunnel > 0 ? 'In progress' : 'Not established' },
          { label: 'Traffic', value: state.dial.traffic >= 1 ? 'Verified end to end' : state.dial.tunnel > 0 ? 'Not verified' : 'No tunnel' },
          { label: 'Guard', value: state.dial.guard >= 1 ? 'Fail-closed armed' : state.dial.guard > 0 ? 'Partially armed' : 'Not armed' },
        ].map((item) => (
          <div key={item.label} className="flex items-baseline justify-between gap-3 bg-surface px-6 py-3">
            <span className="np-label">{item.label}</span>
            <span className="font-mono text-micro text-text">{item.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
