import { useCallback, useEffect, useMemo, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { coloLabel } from '@netpulse/shared';
import { Cloud, Download, Gauge, MapPin, Radar, ShieldCheck, ShieldX, Star, X } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { usePersistentId, usePersistentState } from '@/lib/usePersistentState';
import { timeAgo } from '@/lib/format';

interface ScanCandidateRow {
  id: number;
  scanId: string;
  endpoint: string;
  port: number;
  tcpMs: number | null;
  tlsMs: number | null;
  httpMs: number | null;
  httpStatus: number | null;
  score: number | null;
  status: string;
  label: string;
  favorite: boolean;
  colo: string | null;
  loc: string | null;
  lossPct: number | null;
  jitterMs: number | null;
  downloadMbps: number | null;
  ttfbMs: number | null;
  validated: boolean;
  clean: boolean | null;
}

interface ScanSummaryDto {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  startedAt: number;
  finishedAt: number | null;
  discovered: number;
  tested: number;
  alive: number;
  error?: string;
}

interface ScanDetail {
  scan: ScanSummaryDto;
  candidates: ScanCandidateRow[];
}

interface ScansResponse {
  scans: ScanSummaryDto[];
}

interface LocalEdge {
  reachable: boolean;
  colo: string | null;
  loc: string | null;
  label: string | null;
}

type SortKey = 'best' | 'speed' | 'region';

const DEFAULT_CIDRS = '104.16.0.0/13\n172.64.0.0/13';

const VALIDATION_MAX = 20;

function toCsv(rows: ScanCandidateRow[]): string {
  const header = 'endpoint,port,tcp_ms,tls_ms,http_ms,http_status,colo,loc,loss_pct,jitter_ms,download_mbps,ttfb_ms,clean,score,status';
  const lines = rows.map((r) =>
    [
      r.endpoint,
      r.port,
      r.tcpMs ?? '',
      r.tlsMs ?? '',
      r.httpMs ?? '',
      r.httpStatus ?? '',
      r.colo ?? '',
      r.loc ?? '',
      r.lossPct ?? '',
      r.jitterMs ?? '',
      r.downloadMbps ?? '',
      r.ttfbMs ?? '',
      r.clean == null ? '' : r.clean ? 'clean' : 'filtered',
      r.score ?? '',
      r.status,
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

export default function CloudflarePage() {
  const scansQuery = useQuery({
    queryKey: ['cloudflare', 'scans'],
    queryFn: () => api.get<ScansResponse>('/cloudflare/scans?limit=15'),
    refetchInterval: 4_000,
  });

  // Selection + validation persist across tab switches: CF scans run for
  // minutes server-side, and detailQuery polls by id — so returning to the
  // tab re-attaches to the live scan instead of dropping the user's place.
  const [selectedId, setSelectedId] = usePersistentId('cf.selectedId');
  // SenPai-style post-stop validation of the shortlist (runs server-side).
  // Declared before detailQuery: its refetchInterval closure reads them.
  const [validatingId, setValidatingId] = usePersistentId('cf.validatingId');
  const [validationTarget, setValidationTarget] = useState(0);
  const [validationError, setValidationError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['cloudflare', 'scan', selectedId],
    queryFn: () => api.get<ScanDetail>(`/cloudflare/scans/${selectedId}`),
    enabled: selectedId != null,
    refetchInterval: (query) => {
      const scan = query.state.data?.scan;
      if (validatingId != null && validatingId === selectedId) return 1_500;
      return scan?.status === 'running' ? 2_000 : false;
    },
  });

  const [cidrText, setCidrText] = usePersistentState<string>('cf.cidrText', DEFAULT_CIDRS);
  const [portText, setPortText] = usePersistentState<string>('cf.portText', '443,2053');
  const [maxCandidates, setMaxCandidates] = usePersistentState<number>('cf.maxCandidates', 256);
  const [startError, setStartError] = useState<string | null>(null);

  const [filter, setFilter] = usePersistentState<string>('cf.filter', '');
  const [onlyAlive, setOnlyAlive] = usePersistentState<boolean>('cf.onlyAlive', true);
  const [onlyClean, setOnlyClean] = usePersistentState<boolean>('cf.onlyClean', false);
  const [sortKey, setSortKey] = usePersistentState<SortKey>('cf.sortKey', 'best');

  // The Cloudflare datacenter this machine's traffic exits from.
  const edgeQuery = useQuery({
    queryKey: ['cloudflare', 'edge'],
    queryFn: () => api.get<LocalEdge>('/cloudflare/edge'),
    staleTime: 60_000,
  });

  const startScan = useCallback(async () => {
    setStartError(null);
    const cidrs = cidrText.split('\n').map((s) => s.trim()).filter(Boolean);
    const ports = portText.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (cidrs.length === 0 || ports.length === 0) {
      setStartError('Provide at least one CIDR and one port.');
      return;
    }
    try {
      const res = await api.post<{ scanId: string; summary: ScanSummaryDto }>('/cloudflare/scan', {
        cidrs,
        ports,
        maxCandidates,
      });
      setSelectedId(res.scanId);
      void scansQuery.refetch();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Scan failed to start');
    }
  }, [cidrText, portText, maxCandidates, scansQuery]);

  const cancelScan = useCallback(async () => {
    if (!selectedId) return;
    await api.post(`/cloudflare/scans/${selectedId}/cancel`);
    void scansQuery.refetch();
  }, [selectedId, scansQuery]);

  const startValidation = useCallback(async () => {
    if (!selectedId) return;
    setValidationError(null);
    const scan = detailQuery.data?.scan;
    const alive = detailQuery.data?.candidates.filter((c) => c.status !== 'unreachable' && c.status !== 'untested') ?? [];
    if (!scan || alive.length === 0) {
      setValidationError('No alive endpoints to validate — run a scan first.');
      return;
    }
    try {
      const res = await api.post<{ validationId: string; scanId: string; queued: number }>(
        `/cloudflare/scans/${selectedId}/validate`,
        {},
      );
      setValidatingId(scan.id);
      setValidationTarget(Math.min(res.queued, VALIDATION_MAX));
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Validation failed to start');
    }
  }, [selectedId, detailQuery.data]);

  const cancelValidation = useCallback(async () => {
    if (!selectedId || validatingId == null) return;
    await api.post(`/cloudflare/scans/${selectedId}/validate/cancel`);
    setValidatingId(null);
  }, [selectedId, validatingId]);

  // completion detector: every attempted endpoint ends validated=true
  useEffect(() => {
    if (validatingId == null || validatingId !== selectedId) return;
    const rows = detailQuery.data?.candidates ?? [];
    const validatedCount = rows.filter((r) => r.validated).length;
    if (validatedCount >= validationTarget && validationTarget > 0) {
      setValidatingId(null);
      void detailQuery.refetch();
    }
  }, [validatingId, selectedId, validationTarget, detailQuery.data, detailQuery]);

  const toggleFavorite = useCallback(
    async (row: ScanCandidateRow) => {
      if (!selectedId) return;
      await api.post(`/cloudflare/candidates/${row.id}/favorite`, { favorite: !row.favorite });
      void detailQuery.refetch();
    },
    [selectedId, detailQuery],
  );

  const candidates = useMemo(() => detailQuery.data?.candidates ?? [], [detailQuery.data]);
  const validating = validatingId != null && validatingId === selectedId;
  const validatedCount = candidates.filter((c) => c.validated).length;
  const cleanCount = candidates.filter((c) => c.clean === true).length;

  const regionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of candidates) {
      if (!c.colo) continue;
      counts.set(c.colo, (counts.get(c.colo) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [candidates]);

  const filtered = useMemo(() => {
    let rows = onlyAlive ? candidates.filter((c) => c.status !== 'unreachable' && c.status !== 'untested') : candidates;
    if (onlyClean) rows = rows.filter((c) => c.clean === true);
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      rows = rows.filter((c) => c.endpoint.includes(q) || String(c.port).includes(q) || (c.colo ?? '').toLowerCase().includes(q));
    }
    const sorted = [...rows];
    switch (sortKey) {
      case 'speed':
        // validated + fastest download first, then clean, then score
        sorted.sort((a, b) => {
          const aRank = a.clean === true ? 0 : a.validated ? 1 : 2;
          const bRank = b.clean === true ? 0 : b.validated ? 1 : 2;
          if (aRank !== bRank) return aRank - bRank;
          return (b.downloadMbps ?? -1) - (a.downloadMbps ?? -1);
        });
        break;
      case 'region':
        sorted.sort((a, b) => {
          const aClean = a.clean === true ? 0 : 1;
          const bClean = b.clean === true ? 0 : 1;
          if (aClean !== bClean) return aClean - bClean;
          return (a.colo ?? 'zzz').localeCompare(b.colo ?? 'zzz');
        });
        break;
      default:
        // discovery score is higher = better; validated endpoints go first
        sorted.sort((a, b) => {
          const aV = a.validated ? 0 : 1;
          const bV = b.validated ? 0 : 1;
          if (aV !== bV) return aV - bV;
          return (b.score ?? -1) - (a.score ?? -1);
        });
    }
    return sorted;
  }, [candidates, onlyAlive, onlyClean, filter, sortKey]);

  const scan = detailQuery.data?.scan;
  const running = scan?.status === 'running';
  const testedPct = scan && scan.discovered > 0 ? Math.min(100, Math.round((scan.tested / scan.discovered) * 100)) : 0;

  const exportCsv = useCallback(() => {
    const blob = new Blob([toCsv(filtered)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloudflare-scan-${selectedId ?? 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, selectedId]);

  const edge = edgeQuery.data;
  const edgeLabel = edge?.label ?? null;

  return (
    <div>
      <PageHeader
        title="Cloudflare endpoints"
        description="Discover Cloudflare edge IPs, learn which region each one routes to, then validate the shortlist with a real download — a clean edge must answer /cdn-cgi/trace, survive an idle hold, and actually carry traffic (SenPaiScanner-style methodology)."
        actions={
          running ? (
            <Button variant="danger" onClick={() => void cancelScan()}>
              Cancel scan
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void startScan()}>
              <Radar size={14} />
              Start scan
            </Button>
          )
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Scan configuration" subtitle="Only Cloudflare-published ranges or ranges you are authorized to test" />
          <CardBody className="space-y-3">
            <Field label="CIDRs (one per line)">
              <textarea
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
                rows={4}
                value={cidrText}
                onChange={(e) => setCidrText(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Ports">
                <input
                  className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm"
                  value={portText}
                  onChange={(e) => setPortText(e.target.value)}
                />
              </Field>
              <Field label="Max candidates">
                <input
                  type="number"
                  min={16}
                  max={2048}
                  className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm"
                  value={maxCandidates}
                  onChange={(e) => setMaxCandidates(Number(e.target.value))}
                />
              </Field>
            </div>
            {startError && <p className="text-xs text-danger">{startError}</p>}
            <p className="text-xs text-faint">
              Discovery probes each candidate over TCP → TLS → <span className="font-mono">/cdn-cgi/trace</span> and records which
              Cloudflare datacenter (colo) answered. Candidates are sampled on an even stride across each CIDR
              (max {maxCandidates} total), so Cloudflare's published /13s scan fine.
            </p>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title={scan ? `Scan ${scan.id.slice(0, 8)}` : 'Live results'}
            icon={<Cloud size={15} />}
            actions={
              scan && (
                <div className="flex items-center gap-2">
                  {edgeLabel && (
                    <span className="hidden items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted md:flex" title="The Cloudflare datacenter this machine's traffic exits from">
                      <MapPin size={11} className="text-accent" />
                      {edgeLabel}
                    </span>
                  )}
                  <Badge tone={scan.status === 'completed' ? 'ok' : scan.status === 'running' ? 'accent' : scan.status === 'error' ? 'danger' : 'neutral'}>
                    {scan.status}
                  </Badge>
                  {filtered.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={exportCsv}>
                      <Download size={12} />
                      CSV
                    </Button>
                  )}
                </div>
              )
            }
          />
          <CardBody>
            {running && (
              <div className="mb-4">
                <div className="mb-1 flex justify-between text-xs text-faint">
                  <span>{scan?.tested ?? 0} / {scan?.discovered ?? 0} endpoints tested</span>
                  <span>{scan?.alive ?? 0} alive</span>
                </div>
                <Progress value={testedPct} />
              </div>
            )}

            {validating && (
              <div className="mb-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 font-medium text-accent">
                    <Gauge size={13} className="animate-pulse" />
                    Validating {Math.min(validatedCount, validationTarget)}/{validationTarget} shortlist endpoints — multi-try latency, DPI idle hold, then a real download through each edge
                  </span>
                  <button className="text-faint hover:text-danger" onClick={() => void cancelValidation()} title="Cancel validation">
                    <X size={14} />
                  </button>
                </div>
                <div className="mt-2">
                  <Progress value={validationTarget > 0 ? (validatedCount / validationTarget) * 100 : 0} />
                </div>
              </div>
            )}
            {validationError && <p className="mb-3 text-xs text-danger">{validationError}</p>}

            {!selectedId && (
              <EmptyState
                icon={<Radar size={20} />}
                title="No scan selected"
                message="Configure ranges on the left and start a scan. Results stream in live with the Cloudflare region each endpoint answered from."
              />
            )}

            {selectedId && detailQuery.isLoading && <LoadingState label="Loading scan" />}
            {selectedId && detailQuery.error != null && <ErrorState error={detailQuery.error} retry={() => void detailQuery.refetch()} />}

            {scan && !detailQuery.isLoading && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <input
                    className="h-8 w-48 rounded-lg border border-line bg-surface-2 px-3 text-xs"
                    placeholder="Filter by IP / port / region…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={onlyAlive} onChange={(e) => setOnlyAlive(e.target.checked)} />
                    alive only
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={onlyClean} onChange={(e) => setOnlyClean(e.target.checked)} />
                    clean only
                  </label>
                  {!running && !validating && scan.status === 'completed' && (
                    <Button variant="primary" size="sm" onClick={() => void startValidation()} disabled={validatingId != null}>
                      <ShieldCheck size={13} />
                      Validate shortlist
                    </Button>
                  )}
                  {validatedCount > 0 && (
                    <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
                      <span className="text-ok">✓ {cleanCount} clean</span>
                      <span className="text-danger">✗ {validatedCount - cleanCount} filtered</span>
                    </span>
                  )}
                </div>

                {validatedCount > 0 && regionCounts.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {regionCounts.slice(0, 8).map(([code, n]) => (
                      <span key={code} title={coloLabel(code) ?? code} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">
                        {code} × {n}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mb-2 flex gap-1 text-[11px]">
                  {(['best', 'speed', 'region'] as const).map((key) => (
                    <button
                      key={key}
                      onClick={() => setSortKey(key)}
                      className={`rounded-md px-2 py-0.5 capitalize ${sortKey === key ? 'bg-accent/15 text-accent' : 'text-faint hover:text-muted'}`}
                    >
                      {key === 'best' ? 'by latency score' : key === 'speed' ? 'by download' : 'by region'}
                    </button>
                  ))}
                </div>

                {filtered.length === 0 ? (
                  <p className="py-6 text-center text-sm text-faint">
                    {running ? 'No alive endpoints yet — the scan is still working.' : 'No endpoints matched. Widen the filter or run another scan.'}
                  </p>
                ) : (
                  <div className="max-h-[420px] overflow-auto">
                    <table className="w-full text-[13px]">
                      <thead className="sticky top-0 bg-surface-1">
                        <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                          <th className="py-2 pr-3 font-medium">Endpoint</th>
                          <th className="py-2 pr-3 font-medium">Region</th>
                          <th className="py-2 pr-3 text-right font-medium">RTT</th>
                          <th className="py-2 pr-3 text-right font-medium">Loss</th>
                          <th className="py-2 pr-3 text-right font-medium">↓ Mbps</th>
                          <th className="py-2 pr-3 font-medium">Verdict</th>
                          <th className="py-2 pr-3 text-right font-medium">Score</th>
                          <th className="py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((c) => {
                          const regionLabel = coloLabel(c.colo);
                          const rtt = c.validated ? c.tcpMs ?? c.tlsMs : c.tcpMs != null && c.tlsMs != null ? c.tcpMs + c.tlsMs : c.tcpMs ?? c.tlsMs;
                          return (
                            <tr key={c.id} className="border-b border-line/40 last:border-0">
                              <td className="py-2 pr-3 font-mono">{c.endpoint}:{c.port}</td>
                              <td className="py-2 pr-3 font-mono" title={regionLabel ?? undefined}>
                                {c.colo ? <span className="text-accent">{regionLabel ?? c.colo}</span> : <span className="text-faint">—</span>}
                              </td>
                              <td className="py-2 pr-3 text-right font-mono text-muted">
                                {rtt != null ? `${rtt.toFixed(0)} ms` : '—'}
                                {c.jitterMs != null && <span className="ml-1 text-[10px] text-faint">±{c.jitterMs.toFixed(0)}</span>}
                              </td>
                              <td className="py-2 pr-3 text-right font-mono text-muted">
                                {c.lossPct != null ? `${c.lossPct.toFixed(0)}%` : '—'}
                              </td>
                              <td className="py-2 pr-3 text-right font-mono">
                                {c.downloadMbps != null ? (
                                  <span className={c.downloadMbps >= 5 ? 'text-ok' : 'text-warn'}>{c.downloadMbps.toFixed(1)}</span>
                                ) : (
                                  <span className="text-faint">—</span>
                                )}
                              </td>
                              <td className="py-2 pr-3">
                                {c.clean === true ? (
                                  <Badge tone="ok">
                                    <ShieldCheck size={11} className="mr-1 inline" />
                                    Clean
                                  </Badge>
                                ) : c.validated ? (
                                  <Badge tone="danger">
                                    <ShieldX size={11} className="mr-1 inline" />
                                    Filtered
                                  </Badge>
                                ) : (
                                  <Badge tone={c.status === 'alive' ? 'accent' : 'neutral'}>{c.status}</Badge>
                                )}
                                <div className="mt-0.5 max-w-[150px] truncate text-[10px] text-faint" title={c.label}>
                                  {c.label}
                                </div>
                              </td>
                              <td className="py-2 pr-3 text-right font-mono">{c.score != null ? c.score.toFixed(0) : '—'}</td>
                              <td className="py-2 text-right">
                                <button
                                  className="text-faint hover:text-accent"
                                  title={c.favorite ? 'Unfavorite' : 'Favorite'}
                                  onClick={() => void toggleFavorite(c)}
                                >
                                  <Star size={14} className={c.favorite ? 'fill-accent text-accent' : ''} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {scan.error && <p className="mt-3 text-xs text-danger">{scan.error}</p>}
                <p className="mt-3 text-[11px] text-faint">
                  Discovery marks TCP/TLS-reachable edges; the verdict needs validation. “Clean” means ≥2 of 3 probes succeeded, a
                  Cloudflare colo answered, the TLS connection survived an idle hold, and a real download carried data — an edge that
                  handshakes but cannot transfer is marked filtered.
                </p>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="Scan history" />
        <CardBody>
          {scansQuery.isLoading && <LoadingState label="Loading scans" />}
          {scansQuery.data && scansQuery.data.scans.length === 0 && (
            <p className="py-4 text-center text-sm text-faint">No scans recorded yet.</p>
          )}
          {scansQuery.data && scansQuery.data.scans.length > 0 && (
            <ul className="space-y-1.5">
              {scansQuery.data.scans.map((s) => (
                <li key={s.id}>
                  <button
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-surface-2 ${selectedId === s.id ? 'bg-surface-2' : ''}`}
                    onClick={() => {
                      setSelectedId(s.id);
                      setValidatingId(null);
                    }}
                  >
                    <span className="font-mono text-muted">
                      {s.id.slice(0, 8)} · {s.alive}/{s.tested} alive
                    </span>
                    <span className="flex items-center gap-2 text-xs text-faint">
                      <Badge tone={s.status === 'completed' ? 'ok' : s.status === 'running' ? 'accent' : 'neutral'}>{s.status}</Badge>
                      {timeAgo(s.finishedAt ?? s.startedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
