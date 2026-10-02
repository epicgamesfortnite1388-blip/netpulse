import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Radar, Search, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Progress } from '@/components/ui/Progress';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { subscribeTest } from '@/lib/ws';
import { usePersistentState } from '@/lib/usePersistentState';

import {
  budgetNote,
  failureBreakdown,
  formatLatency,
  needsMissingCore,
  outcomeLabel,
  reportState,
  validatedDepth,
  validatedSummary,
} from './discoveryReport';

import type { ScanProfileId, DiscoveryReport } from '@netpulse/shared';
import type { ProxyEngineStatus } from '@netpulse/shared';

import { SCAN_PROFILE_IDS, SCAN_PROFILES } from '@netpulse/shared';

/**
 * Node discovery — pick a scan profile, run it, read what it actually found.
 *
 * Aether's scan modes exist so the user chooses the trade-off between how fast
 * a working node is found and how much probe traffic that search emits. That
 * choice is only real if the result is equally honest: this card shows the
 * counts the run produced, the depth that was genuinely validated, and the
 * verbatim failure reasons — and shows an explicit unavailable state instead
 * of numbers when there is nothing to report.
 *
 * Two deliberate behaviours:
 *   - one run at a time. The button disables while a run is in flight AND the
 *     mutation refuses to start a second request, so a double click cannot
 *     spawn two probe pools.
 *   - the report's own profile is displayed, not the currently selected one,
 *     so changing the picker afterwards cannot relabel an older result.
 */

const DISCOVERY_TOPIC = 'discovery';
/** Outcome rows rendered before the list is truncated (count always real). */
const MAX_OUTCOME_ROWS = 12;

/**
 * Protocol the scan may consider. 'all' is the unfiltered pool; the rest map to
 * the API's own `protocol` filter, so narrowing the search is a real filter on
 * the candidate query rather than a client-side trim of the results.
 *
 * UDP families are listed because discovering them is legitimate — using the
 * result is what needs a capable core, and the run says so when one is missing.
 */
const PROTOCOL_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All protocols' },
  { value: 'vless', label: 'VLESS' },
  { value: 'vmess', label: 'VMess' },
  { value: 'trojan', label: 'Trojan' },
  { value: 'hysteria2', label: 'Hysteria2' },
];

interface DiscoveryProgress {
  done: number;
  total: number;
  profile: string;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function DiscoveryCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [profile, setProfile] = usePersistentState<ScanProfileId>('vpn.scanProfile', 'balanced');
  // 'all' or a protocol name the candidate query can filter on.
  const [protocol, setProtocol] = usePersistentState<string>('vpn.discoveryProtocol', 'all');
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  /** Hard single-flight latch: survives a double click React has not re-rendered for yet. */
  const inFlight = useRef(false);

  // Real availability of a local core — used to explain a proxy-depth profile
  // that cannot validate anything on this machine.
  const enginesQuery = useQuery({
    queryKey: ['nodes', 'engines'],
    queryFn: () => api.get<ProxyEngineStatus>('/nodes/engines').catch(() => null),
    staleTime: 60_000,
  });

  // Live progress frames. Rendered only while a run is in flight, so a cached
  // frame replayed to a late subscriber can never look like a current run.
  useEffect(() => {
    const unsub = subscribeTest(DISCOVERY_TOPIC, (msg) => {
      if (msg.type !== 'discovery:progress') return;
      const done = typeof msg.done === 'number' ? msg.done : null;
      const total = typeof msg.total === 'number' ? msg.total : null;
      if (done === null || total === null || total <= 0) return;
      setProgress({ done, total, profile: typeof msg.profile === 'string' ? msg.profile : '' });
    });
    return unsub;
  }, []);

  const run = useMutation({
    mutationFn: async (selected: ScanProfileId) => {
      // Second guard for the same invariant as the disabled button.
      if (inFlight.current) return null;
      inFlight.current = true;
      try {
        return await api.post<{ report: DiscoveryReport }>('/vpn/discover', {
          profile: selected,
          // Only sent when narrowing: an explicit protocol turns the candidate
          // query into a filtered one server-side.
          ...(protocol === 'all' ? {} : { protocol }),
        });
      } finally {
        inFlight.current = false;
      }
    },
    onSuccess: (data) => {
      setProgress(null);
      if (!data) return; // duplicate click dropped before the request
      setReport(data.report);
      // Node test results changed — refresh the surfaces that read them.
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      const state = reportState(data.report);
      if (state === 'found') toast('ok', 'Scan complete', validatedSummary(data.report));
      else toast('warn', 'Scan found nothing usable', data.report.summary);
    },
    onError: (err) => {
      setProgress(null);
      setReport(null);
      toast('error', 'Scan failed', err instanceof Error ? err.message : undefined);
    },
  });

  const busy = run.isPending;
  const selected = SCAN_PROFILES[profile];
  const coreMissing = needsMissingCore(profile, enginesQuery.data?.effective);
  const state = report ? reportState(report) : null;
  const breakdown = report ? failureBreakdown(report) : [];
  const depth = report ? validatedDepth(report) : null;
  const rows = report ? report.outcomes.slice(0, MAX_OUTCOME_ROWS) : [];

  return (
    <Card
      className="mb-6"
      fold={{
        id: 'discovery',
        defaultOpen: false,
        // The folded header reports the same real counters the report does, so a
        // closed card never reads as "nothing happened".
        summary: report
          ? `${report.probed} probed · ${report.passed} validated${depth ? ` · deepest evidence: ${depth}` : ''}`
          : 'not run yet — picks how deep each candidate is validated',
      }}
    >
      <CardHeader
        title="Node discovery"
        icon={<Radar size={15} />}
        subtitle="Search the node database for one worth connecting to. The profile decides how deep each candidate is validated and roughly how much probe traffic the search emits."
        actions={report ? <Badge tone={state === 'found' ? 'ok' : state === 'nothing-passed' ? 'warn' : 'neutral'}>
          {state === 'found' ? `${report.passed} validated` : state === 'nothing-passed' ? 'nothing validated' : 'no candidates'}
        </Badge> : null}
      />
      <CardBody className="space-y-4">
        {/* Which protocol family the scan may consider. Narrowing here is the
            only way to look for a protocol the default pool under-represents
            (a hysteria2 node, for instance). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-xs text-muted">Candidates to consider</span>
          <Segmented
            value={protocol}
            onChange={setProtocol}
            items={PROTOCOL_FILTERS}
            ariaLabel="Discovery protocol filter"
          />
          {protocol === 'hysteria2' && (
            <span className="text-micro leading-snug text-faint">
              A hysteria2 result needs sing-box or the Hysteria2 client installed to test or tunnel.
            </span>
          )}
        </div>

        <div role="radiogroup" aria-label="Discovery profile" className="space-y-2">
          {SCAN_PROFILE_IDS.map((id) => {
            const p = SCAN_PROFILES[id];
            const isSelected = id === profile;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={busy}
                onClick={() => setProfile(id)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition disabled:opacity-60 ${
                  isSelected ? 'border-accent/50 bg-accent-soft' : 'border-transparent bg-surface-2/70 hover:bg-surface-2'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="text-sm text-text">{p.label}</span>
                  <span className="text-micro text-faint">
                    {p.depth === 'proxy' ? 'real proxied request' : p.depth === 'tls' ? 'TLS handshake' : 'TCP handshake'} · up to{' '}
                    {p.candidateLimit} candidates · {p.timeoutMs} ms each
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-faint">{p.summary}</p>
              </button>
            );
          })}
        </div>

        {coreMissing && (
          <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              {selected.label} validates by opening a real tunnel through each candidate, but no local proxy core is
              installed (xray / sing-box / v2ray), so every candidate will fail validation. Install a core from the
              Node Explorer&apos;s proxy-core section, or choose Turbo or Balanced, which validate without one.
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => run.mutate(profile)} loading={busy} disabled={busy}>
            <Search size={12} />
            {busy ? 'Scanning…' : `Run ${selected.label} scan`}
          </Button>
          {report && !busy && (
            <span className="text-xs text-faint">
              Last run: {SCAN_PROFILES[report.profile]?.label ?? report.profile} · {formatDuration(report.tookMs)} · probed{' '}
              {report.probed}
            </span>
          )}
        </div>

        {busy && (
          <div className="space-y-2 rounded-lg bg-surface-2/70 p-3">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>
                {progress ? `Probing candidate ${progress.done} of ${progress.total}` : 'Starting scan…'}
              </span>
              {progress && <span className="text-faint">{Math.round((progress.done / progress.total) * 100)}%</span>}
            </div>
            {/* Indeterminate until a real frame arrives — never a guessed percentage. */}
            <Progress value={progress ? (progress.done / progress.total) * 100 : undefined} indeterminate={!progress} />
          </div>
        )}

        {run.isError && <ErrorState error={run.error} retry={() => run.mutate(profile)} />}

        {!report && !busy && !run.isError && (
          <EmptyState
            icon={<Radar size={16} />}
            title="No scan yet"
            message="Pick a profile and run a scan to see how many candidates were probed, how many were validated, and why the rest failed."
          />
        )}

        {report && !busy && (
          <div className="space-y-3">
            <div className="rounded-lg bg-surface-2/70 p-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted">
                <span>
                  Profile: <span className="text-text">{SCAN_PROFILES[report.profile]?.label ?? report.profile}</span>
                </span>
                <span>
                  Probed: <span className="text-text">{report.probed}</span>
                </span>
                <span>
                  Validated: <span className="text-text">{report.passed}</span>
                </span>
                <span>
                  Failed: <span className="text-text">{report.outcomes.length - report.passed}</span>
                </span>
                <span>
                  Took: <span className="text-text">{formatDuration(report.tookMs)}</span>
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted">{validatedSummary(report)}</p>
              <p className="mt-1 text-xs text-faint">{budgetNote(report)}</p>
            </div>

            {report.winner ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-r-lg border-l-2 border-ok/50 bg-ok/5 px-3 py-2.5 text-sm">
                <span className="flex items-center gap-1.5 text-ok">
                  <CheckCircle2 size={13} /> Best candidate
                </span>
                <span className="text-text">{outcomeLabel(report.winner)}</span>
                <span className="text-muted">
                  {report.winner.host}:{report.winner.port} · {report.winner.protocol}
                </span>
                <span className="text-muted">
                  {formatLatency(report.winner.latencyMs) ?? 'latency not measured'}
                </span>
                {depth && <span className="text-faint">validated: {depth === 'proxy' ? 'carries traffic' : depth === 'tls' ? 'TLS' : 'TCP'}</span>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-r-lg border-l-2 border-warn/60 bg-warn/5 px-3 py-2.5 text-xs leading-relaxed text-warn">
                <XCircle size={13} className="shrink-0" />
                <span>
                  {state === 'no-candidates'
                    ? 'No candidate was available to probe, so nothing could be recommended. Import node sources first.'
                    : 'No candidate reached this profile’s depth, so nothing was recommended. This run is not evidence that no node works — only that none of the probed candidates answered.'}
                </span>
              </div>
            )}

            {breakdown.length > 0 && (
              <div className="rounded-lg bg-surface-2/70 p-3">
                <p className="mb-1.5 text-micro uppercase tracking-wide text-faint">
                  Failure reasons (as reported, verbatim)
                </p>
                <ul className="space-y-1">
                  {breakdown.map((f) => (
                    <li key={f.reason} className="flex items-baseline gap-2 text-xs">
                      <span className="shrink-0 text-muted">{f.count}×</span>
                      <span className="min-w-0 break-words text-faint">{f.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {rows.length > 0 && (
              <div className="rounded-lg bg-surface-2/70">
                <div className="border-b border-line px-3 py-2 text-micro uppercase tracking-wide text-faint">
                  Candidates probed
                </div>
                <ul className="divide-y divide-line">
                  {rows.map((o) => (
                    <li key={o.nodeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                      <span className="min-w-0 flex-1 truncate text-text">{outcomeLabel(o)}</span>
                      <span className="text-faint">
                        {o.host}:{o.port}
                      </span>
                      <span className="text-faint">{o.protocol}</span>
                      {o.failure === null ? (
                        <Badge tone="ok">{o.depth === 'proxy' ? 'carries traffic' : o.depth === 'tls' ? 'TLS ok' : 'TCP ok'}</Badge>
                      ) : (
                        <Badge tone="danger">failed</Badge>
                      )}
                      <span className="w-16 text-right text-muted">
                        {formatLatency(o.latencyMs) ?? (o.failure === null ? 'not measured' : '—')}
                      </span>
                      {o.failure !== null && (
                        <span className="w-full break-words text-faint">{o.failure}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {report.outcomes.length > rows.length && (
                  <p className="border-t border-line px-3 py-2 text-micro text-faint">
                    Showing {rows.length} of {report.outcomes.length} probed candidates.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
