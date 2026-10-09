import { useQuery } from '@tanstack/react-query';
import { Activity, History, Radar, Zap } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { api } from '@/lib/api';

import { SCAN_PROFILES } from '@netpulse/shared';

import type { GatewayReliabilityRow, DiscoveryProfileRollup, VpnHistoryReport } from '@netpulse/shared';

/**
 * VPN history dashboard — discovery-profile outcomes and gateway-memory
 * reliability over time.
 *
 * Everything rendered comes from GET /vpn/history, whose numbers are computed
 * from stored rows (discovery/quick-connect events + gateway memory). The
 * card's own honesty rules mirror the rest of the VPN surface:
 *   - a profile with no runs shows "no runs yet", not zeros
 *   - a percentage that cannot be computed (no attempts) renders as —
 *   - "last validated depth" is what the run PROVED, carried from the stored
 *     event, never re-derived from a later state
 */

function pct(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(0)}%` : '—';
}

function when(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/** Bars for one profile: passed vs probed per run, newest first. */
function ProfileSparkline({ rollup, runs }: { rollup: DiscoveryProfileRollup; runs: VpnHistoryReport['discovery']['runs'] }) {
  const mine = runs.filter((r) => r.profile === rollup.profile).slice(0, 12).reverse();
  const max = Math.max(1, ...mine.map((r) => r.probed));
  return (
    <div className="flex h-8 items-end gap-1">
      {mine.map((r) => {
        const passedH = Math.round((r.passed / max) * 100);
        const probedH = Math.max(passedH, Math.round((r.probed / max) * 100));
        return (
          <div
            key={r.id}
            className="relative w-3 overflow-hidden rounded-sm bg-surface-2"
            style={{ height: '100%' }}
            title={`${new Date(r.at).toLocaleTimeString()} — probed ${r.probed}, validated ${r.passed}`}
          >
            <div className="absolute bottom-0 w-full rounded-sm bg-line" style={{ height: `${probedH}%` }} />
            <div className="absolute bottom-0 w-full rounded-sm bg-ok/70" style={{ height: `${passedH}%` }} />
          </div>
        );
      })}
      {mine.length === 0 && <span className="text-xs text-faint">no runs yet</span>}
    </div>
  );
}

export function VpnHistoryCard() {
  const historyQuery = useQuery({
    queryKey: ['vpn', 'history'],
    queryFn: () => api.get<{ history: VpnHistoryReport }>('/vpn/history'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const history = historyQuery.data?.history;
  const rollups = history?.discovery.rollups ?? [];
  const runs = history?.discovery.runs ?? [];
  const gateways = history?.gateways ?? [];
  const quick = history?.quickConnect;

  return (
    <Card
      className="mb-6"
      fold={{
        id: 'vpn-history',
        defaultOpen: false,
        summary: `${runs.length} scan${runs.length === 1 ? '' : 's'} · ${quick?.totalRuns ?? 0} quick connect${(quick?.totalRuns ?? 0) === 1 ? '' : 's'} · ${gateways.length} gateways remembered`,
      }}
    >
      <CardHeader
        title="VPN history"
        icon={<History size={15} />}
        subtitle="Discovery-scan outcomes and gateway reliability, computed from this app's own stored runs — nothing extrapolated"
        actions={
          <Badge tone="neutral">
            {runs.length} scan{runs.length === 1 ? '' : 's'} · {quick?.totalRuns ?? 0} quick connect{(quick?.totalRuns ?? 0) === 1 ? '' : 's'}
          </Badge>
        }
      />
      <CardBody>
        {historyQuery.isLoading && <p className="text-xs text-faint">Loading history…</p>}
        {historyQuery.isError && (
          <EmptyState icon={<History size={16} />} title="History unavailable" message="The backend could not be reached — the dashboard shows nothing rather than stale numbers." />
        )}

        {history && (
          <div className="space-y-5">
            {/* -------- discovery profile outcomes -------- */}
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-micro uppercase tracking-wide text-faint">
                <Radar size={12} />
                Discovery profiles — validated vs probed per run
              </div>
              {rollups.length === 0 ? (
                <EmptyState
                  icon={<Radar size={16} />}
                  title="No scans recorded yet"
                  message="Run a discovery scan above — every completed run lands here with its real probed/validated counts."
                />
              ) : (
                <div className="space-y-2.5">
                  {rollups.map((r) => (
                    <div key={r.profile} className="rounded-lg bg-surface-2/70 p-3">
                      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="text-sm font-medium text-text">{SCAN_PROFILES[r.profile]?.label ?? r.profile}</span>
                        <span className="text-xs text-muted">
                          {r.runs} run{r.runs === 1 ? '' : 's'} · {r.totalPassed}/{r.totalProbed} validated overall · mean pass rate {pct(r.meanPassRatePct)} · last {when(r.lastRunAt)}
                        </span>
                      </div>
                      <div className="flex items-end justify-between gap-4">
                        <ProfileSparkline rollup={r} runs={runs} />
                        <span className="shrink-0 text-micro text-faint">
                          {r.lastValidatedDepth ? `last proof: ${r.lastValidatedDepth}` : 'no candidate validated yet'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* -------- quick connect outcomes -------- */}
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-micro uppercase tracking-wide text-faint">
                <Zap size={12} />
                Quick connect — {quick?.totalRuns ?? 0} run{(quick?.totalRuns ?? 0) === 1 ? '' : 's'}, {quick?.totalAttempts ?? 0} attempt{(quick?.totalAttempts ?? 0) === 1 ? '' : 's'}, success {pct(quick?.successRatePct)}
              </div>
              {(quick?.runs.length ?? 0) === 0 ? (
                <p className="text-xs text-faint">No quick connect recorded yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {quick!.runs.slice(0, 6).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                      <Badge tone={r.ok ? 'ok' : 'danger'}>{r.ok ? 'connected' : 'failed'}</Badge>
                      <span className="text-muted">{when(r.at)}</span>
                      <span className="text-muted">{SCAN_PROFILES[r.profile]?.label ?? r.profile}</span>
                      <span className="text-muted">
                        {r.tried} attempt{r.tried === 1 ? '' : 's'}
                        {r.winningSource ? ` · via ${r.winningSource === 'memory' ? 'remembered gateway' : r.winningSource}` : ''}
                      </span>
                      <span className="text-faint">{duration(r.tookMs)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* -------- gateway reliability -------- */}
            <section>
              <div className="mb-2 flex items-center gap-1.5 text-micro uppercase tracking-wide text-faint">
                <Activity size={12} />
                Gateway memory — proven reliability per remembered node
              </div>
              {gateways.length === 0 ? (
                <EmptyState
                  icon={<Activity size={16} />}
                  title="No gateways remembered yet"
                  message="A gateway is remembered only after the app has personally verified traffic through it — connect once and it appears here."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-micro uppercase tracking-wide text-faint">
                      <tr>
                        <th className="py-1.5 pr-3 font-medium">Gateway</th>
                        <th className="py-1.5 pr-3 font-medium">Engine</th>
                        <th className="py-1.5 pr-3 font-medium">Reliability</th>
                        <th className="py-1.5 pr-3 font-medium">Streak</th>
                        <th className="py-1.5 pr-3 font-medium">Verify ms</th>
                        <th className="py-1.5 pr-3 font-medium">Last verified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gateways.map((g: GatewayReliabilityRow) => (
                        <tr key={g.nodeId} className="border-t border-line">
                          <td className="py-1.5 pr-3">
                            <span className="text-text">{g.name ?? g.label}</span>
                            <span className="ml-1.5 text-faint" title="The gateway's address is withheld — the tunnel dialed it on the server">
                              endpoint hidden
                            </span>
                            {g.exitCountry && <span className="ml-1.5 text-faint">({g.exitCountry})</span>}
                          </td>
                          <td className="py-1.5 pr-3 text-muted">{g.engine}</td>
                          <td className="py-1.5 pr-3">
                            <span className={g.reliabilityPct !== null && g.reliabilityPct >= 50 ? 'text-ok' : g.reliabilityPct !== null ? 'text-warn' : 'text-faint'}>
                              {g.successCount}✓ {g.failCount}✗ · {pct(g.reliabilityPct)}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-muted">{g.successStreak > 0 ? `${g.successStreak}×` : '0 (last failed)'}</td>
                          <td className="py-1.5 pr-3 text-muted">{g.meanVerifyMs !== null ? `${Math.round(g.meanVerifyMs)}` : '—'}</td>
                          <td className="py-1.5 pr-3 text-muted">{when(g.lastVerifiedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
