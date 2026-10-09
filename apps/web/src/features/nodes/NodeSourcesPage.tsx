import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Database,
  Download,
  Globe,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DisclosureScope, DisclosureToolbar, FoldNote } from '@/components/ui/Disclosure';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { MiniMetric, Section, StatTile } from '@/components/ui/Surface';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/Toaster';
import { NodesNav } from '@/features/nodes/NodesChrome';
import { api } from '@/lib/api';
import { usePersistentId, usePersistentState } from '@/lib/usePersistentState';

import type { ReactNode } from 'react';

/**
 * Node Sources — where the node database comes from, and the scans run over it.
 *
 * The page used to be three cards stacked with no heading, a bare page wrapper
 * and no way to tell which part you were looking at. It is now divided by
 * function: Subscriptions (fetch/import), Scanner (batch tests) and Test
 * endpoints (what a "pass" means). Fetching, scanning and endpoint edits are
 * independent activities, so they get independent views.
 */

type SourcesTab = 'sources' | 'scanner' | 'endpoints';

interface SourceRow {
  id: string;
  name: string;
  type: string;
  urls: string[];
  enabled: boolean;
  status?: string;
  health?: string;
  lastFetch?: number | null;
  lastSuccess?: number | null;
  discoveredConfigCount?: number | null;
  importedConfigCount?: number | null;
  duplicateCount?: number | null;
  invalidCount?: number | null;
}

interface ScanJobRow {
  id: string;
  kind: string;
  status: string;
  total?: number;
  done?: number;
  startedAt?: number;
  finishedAt?: number | null;
  error?: string | null;
}

interface TestEndpointRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const SOURCE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  ok: 'ok',
  healthy: 'ok',
  idle: 'neutral',
  pending: 'warn',
  error: 'danger',
  failed: 'danger',
};

/** A row shell shared by sources, scan jobs and endpoints. */
function RowCard({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-line bg-surface-2 p-3.5">{children}</div>;
}

export default function NodeSourcesPage() {
  const toast = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = usePersistentState<SourcesTab>('sources.tab', 'sources');

  // Add-source form — inputs persist across tab switches (fetches take ~10-50s
  // and users routinely jump to another page mid-fetch).
  const [formName, setFormName] = usePersistentState<string>('sources.formName', '');
  const [formUrls, setFormUrls] = usePersistentState<string>('sources.formUrls', '');
  const [adding, setAdding] = useState(false);

  const [teName, setTeName] = usePersistentState<string>('sources.teName', '');
  const [teUrl, setTeUrl] = usePersistentState<string>('sources.teUrl', '');
  const [addingTe, setAddingTe] = useState(false);

  const [scanning, setScanning] = useState(false);

  // In-flight fetch (source id) — persisted so the spinner survives navigating
  // away and back; the fetch itself runs server-side.
  const [fetchingId, setFetchingId] = usePersistentId('sources.fetchingId');

  const sourcesQuery = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.get<{ sources: SourceRow[]; total: number }>('/sources'),
    staleTime: 10_000,
  });

  const jobsQuery = useQuery({
    queryKey: ['scanner', 'jobs'],
    queryFn: () => api.get<{ jobs: ScanJobRow[] }>('/scanner/jobs?limit=10'),
    // Only poll fast while something is actually running; idle stays cheap.
    refetchInterval: (q) => ((q.state.data?.jobs ?? []).some((j) => j.status === 'running') ? 3_000 : 20_000),
  });

  const endpointsQuery = useQuery({
    queryKey: ['test-endpoints'],
    queryFn: () => api.get<{ endpoints: TestEndpointRow[] }>('/test-endpoints'),
    staleTime: 30_000,
  });

  const sources = sourcesQuery.data?.sources ?? [];
  const jobs = jobsQuery.data?.jobs ?? [];
  const endpoints = endpointsQuery.data?.endpoints ?? [];

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['sources'] });
    void qc.invalidateQueries({ queryKey: ['scanner'] });
    void qc.invalidateQueries({ queryKey: ['test-endpoints'] });
  }, [qc]);

  const addSource = useCallback(async () => {
    const urls = formUrls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    if (!formName.trim() || urls.length === 0) return;
    setAdding(true);
    try {
      await api.post('/sources', { name: formName.trim(), urls, type: 'custom' });
      toast('ok', 'Source added');
      setFormName('');
      setFormUrls('');
      void qc.invalidateQueries({ queryKey: ['sources'] });
    } catch (err) {
      toast('error', 'Could not add source', err instanceof Error ? err.message : undefined);
    } finally {
      setAdding(false);
    }
  }, [formName, formUrls, qc, setFormName, setFormUrls, toast]);

  const fetchSource = useCallback(
    async (id: string, name: string) => {
      setFetchingId(id);
      try {
        const res = await api.post<{ imported?: number; duplicates?: number; invalid?: number }>(
          `/sources/${encodeURIComponent(id)}/fetch`,
          {},
        );
        toast(
          'ok',
          `Fetched "${name}"`,
          // 'imported' is the importer's accepted count, which includes configs
          // it recognised from an earlier fetch — labelled so the number cannot
          // be read as "this many new nodes".
          `${res.imported ?? 0} accepted (${res.duplicates ?? 0} already known) · ${res.invalid ?? 0} invalid`,
        );
      } catch (err) {
        toast('error', `Fetch failed for "${name}"`, err instanceof Error ? err.message : undefined);
      } finally {
        setFetchingId(null);
        // Re-read either way: the pipeline persists its own verdict ('failed' +
        // health 'poor'), so a failed source must not keep displaying its
        // previous counts — the toast disappears, the row must not lie.
        void qc.invalidateQueries({ queryKey: ['sources'] });
      }
    },
    [qc, setFetchingId, toast],
  );

  const toggleSource = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await api.patch(`/sources/${encodeURIComponent(id)}`, { enabled });
        void qc.invalidateQueries({ queryKey: ['sources'] });
      } catch (err) {
        toast('error', 'Could not update source', err instanceof Error ? err.message : undefined);
      }
    },
    [qc, toast],
  );

  const deleteSource = useCallback(
    async (id: string, name: string) => {
      try {
        await api.delete(`/sources/${encodeURIComponent(id)}`);
        toast('ok', `Source "${name}" removed`);
        void qc.invalidateQueries({ queryKey: ['sources'] });
      } catch (err) {
        toast('error', 'Could not remove source', err instanceof Error ? err.message : undefined);
      }
    },
    [qc, toast],
  );

  const startScan = useCallback(
    async (kind: 'test' | 'deep-test' | 'health-check') => {
      setScanning(true);
      try {
        const res = await api.post<{ jobId?: string }>('/scanner/start', { kind });
        toast('ok', 'Scan started', res.jobId ? `Job ${res.jobId}` : undefined);
        void qc.invalidateQueries({ queryKey: ['scanner'] });
      } catch (err) {
        toast('error', 'Could not start scan', err instanceof Error ? err.message : undefined);
      } finally {
        setScanning(false);
      }
    },
    [qc, toast],
  );

  const stopScan = useCallback(
    async (jobId: string) => {
      try {
        await api.post(`/scanner/stop/${encodeURIComponent(jobId)}`, {});
        toast('ok', 'Scan cancelled');
        void qc.invalidateQueries({ queryKey: ['scanner'] });
      } catch (err) {
        toast('error', 'Could not stop scan', err instanceof Error ? err.message : undefined);
      }
    },
    [qc, toast],
  );

  const addEndpoint = useCallback(async () => {
    if (!teName.trim() || !teUrl.trim()) return;
    setAddingTe(true);
    try {
      await api.post('/test-endpoints', { name: teName.trim(), url: teUrl.trim() });
      toast('ok', 'Test endpoint added');
      setTeName('');
      setTeUrl('');
      void qc.invalidateQueries({ queryKey: ['test-endpoints'] });
    } catch (err) {
      toast('error', 'Could not add endpoint', err instanceof Error ? err.message : undefined);
    } finally {
      setAddingTe(false);
    }
  }, [qc, setTeName, setTeUrl, teName, teUrl, toast]);

  const deleteEndpoint = useCallback(
    async (id: string) => {
      try {
        await api.delete(`/test-endpoints/${encodeURIComponent(id)}`);
        void qc.invalidateQueries({ queryKey: ['test-endpoints'] });
      } catch (err) {
        toast('error', 'Could not remove endpoint', err instanceof Error ? err.message : undefined);
      }
    },
    [qc, toast],
  );

  if (sourcesQuery.isLoading) return <LoadingState label="Loading sources & scans…" />;
  if (sourcesQuery.isError) return <ErrorState error={sourcesQuery.error} retry={() => void refreshAll()} />;

  const enabledCount = sources.filter((s) => s.enabled).length;
  const failingCount = sources.filter((s) => !s.enabled ? false : s.status === 'error' || s.status === 'failed' || s.health === 'poor').length;
  const importedTotal = sources.reduce((sum, s) => sum + (s.importedConfigCount ?? 0), 0);
  const runningJobs = jobs.filter((j) => j.status === 'running').length;

  return (
    <DisclosureScope name="nodes:sources" className="animate-fade-up">
      <PageHeader
        title="Node Sources"
        description="Where your nodes come from, what tests them, and what counts as working."
        actions={
          <Button variant="ghost" onClick={refreshAll} loading={sourcesQuery.isFetching || jobsQuery.isFetching}>
            <RefreshCw size={13} />
            Refresh
          </Button>
        }
      />

      <NodesNav />
      <DisclosureToolbar className="mb-2" />

      <div className="mb-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sources" value={sources.length} hint={`${enabledCount} enabled`} />
        <StatTile
          label="Imported configs"
          value={importedTotal}
          hint="accepted across all sources"
        />
        <StatTile
          label="Failing sources"
          value={failingCount}
          tone={failingCount > 0 ? 'danger' : 'faint'}
          hint="last fetch reported an error"
        />
        <StatTile
          label="Scan jobs"
          value={jobs.length}
          tone={runningJobs > 0 ? 'warn' : 'default'}
          hint={runningJobs > 0 ? `${runningJobs} running now` : 'none running'}
        />
      </div>

      <Tabs
        items={[
          { value: 'sources', label: 'Subscriptions' },
          { value: 'scanner', label: 'Scanner' },
          { value: 'endpoints', label: 'Test endpoints' },
        ]}
        value={tab}
        onValueChange={(v) => setTab(v as SourcesTab)}
      >
        {/* ------------------------------ sources ------------------------------ */}
        <TabPanel value="sources">
          <Section
            title="Subscription sources"
            icon={<Database size={15} />}
            subtitle="Fetched and imported into the node database; a re-fetch reports accepted counts, not new nodes"
            collapsible
            pinned
            id="source-list"
            badge={<Badge tone={failingCount > 0 ? 'warn' : 'neutral'}>{sources.length} configured</Badge>}
          >
            {sources.length === 0 ? (
              <EmptyState
                icon={<Globe size={22} />}
                title="No sources yet"
                message="Add a subscription URL below to start discovering public proxy configs."
              />
            ) : (
              <div className="space-y-2.5">
                {sources.map((s) => (
                  <RowCard key={s.id}>
                    <div className="flex flex-wrap items-start gap-3">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface">
                        <Database size={14} className="text-accent" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-text">{s.name}</span>
                          <Badge tone={s.enabled ? SOURCE_TONE[s.status ?? 'idle'] ?? 'neutral' : 'neutral'}>
                            {s.enabled ? (s.status ?? 'idle') : 'disabled'}
                          </Badge>
                          {s.type && <span className="text-micro uppercase tracking-wide text-faint">{s.type}</span>}
                        </div>
                        <p
                          className="mt-0.5 truncate font-mono text-micro text-faint select-none"
                          title="Subscription URLs are masked — a link that fetches every node in a source is the configuration, so the app never sends it to the client."
                        >
                          {s.urls[0]}
                        </p>
                        {/* Four across needs xl: at 1024px a four-up grid left ~86px per cell,
                            which the labels overflowed. */}
                          <div className="mt-2 grid grid-cols-2 gap-1.5 xl:grid-cols-4">
                          <MiniMetric label="Discovered" value={String(s.discoveredConfigCount ?? '—')} />
                          <MiniMetric label="Imported" value={String(s.importedConfigCount ?? '—')} />
                          <MiniMetric label="Duplicates" value={String(s.duplicateCount ?? '—')} />
                          <MiniMetric label="Invalid" value={String(s.invalidCount ?? '—')} />
                        </div>
                        <p className="mt-1.5 text-micro text-faint">Last fetch: {fmtTime(s.lastFetch)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void fetchSource(s.id, s.name)}
                          disabled={fetchingId != null}
                        >
                          {fetchingId === s.id ? (
                            <>
                              <Loader2 size={12} className="animate-spin" /> Fetching…
                            </>
                          ) : (
                            <>
                              <Download size={12} /> Fetch
                            </>
                          )}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void toggleSource(s.id, !s.enabled)}>
                          {s.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger"
                          title="Delete source (built-in sources cannot be deleted)"
                          aria-label={`Delete source ${s.name}`}
                          onClick={() => void deleteSource(s.id, s.name)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </div>
                  </RowCard>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Add a source"
            icon={<Plus size={15} />}
            subtitle="https URLs on public hosts only — private, loopback and metadata addresses are rejected"
            collapsible
            defaultOpen={false}
            id="add-source"
            summary="Name + one subscription URL per line"
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Name">
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Community subscriptions"
                  className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-text placeholder:text-faint focus:border-accent/80 focus:outline-none"
                />
              </Field>
              <Field label="Subscription URLs (one per line)">
                <textarea
                  value={formUrls}
                  onChange={(e) => setFormUrls(e.target.value)}
                  rows={2}
                  placeholder="https://raw.githubusercontent.com/…/Sub1.txt"
                  className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-text placeholder:text-faint focus:border-accent/80 focus:outline-none"
                />
              </Field>
            </div>
            <Button
              variant="primary"
              onClick={() => void addSource()}
              loading={adding}
              disabled={!formName.trim() || !formUrls.trim()}
              className="mt-3"
            >
              Add source
            </Button>
          </Section>
        </TabPanel>

        {/* ------------------------------ scanner ------------------------------ */}
        <TabPanel value="scanner">
          <Section
            title="Node scanner"
            icon={<Radar size={15} />}
            subtitle="Batch TCP / TLS / proxy testing of discovered nodes, bounded and cancellable"
            collapsible
            pinned
            id="scanner"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" loading={scanning} onClick={() => void startScan('test')}>
                  <Radar size={12} /> Quick test
                </Button>
                <Button variant="ghost" size="sm" loading={scanning} onClick={() => void startScan('health-check')}>
                  Health check
                </Button>
                <Button variant="ghost" size="sm" loading={scanning} onClick={() => void startScan('deep-test')}>
                  Deep test
                </Button>
              </div>
            }
          >
            {jobs.length === 0 ? (
              <EmptyState
                icon={<Radar size={22} />}
                title="No scan jobs yet"
                message="Start a scan to batch-test the nodes already in your database."
              />
            ) : (
              <div className="space-y-2.5">
                {jobs.map((j) => {
                  const pct = typeof j.done === 'number' && typeof j.total === 'number' && j.total > 0
                    ? Math.round((j.done / j.total) * 100)
                    : null;
                  return (
                    <RowCard key={j.id}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <Badge
                            tone={j.status === 'running' ? 'warn' : j.status === 'completed' ? 'ok' : j.status === 'cancelled' ? 'neutral' : 'danger'}
                          >
                            {j.status}
                          </Badge>
                          <div className="min-w-0">
                            <div className="font-mono text-sm text-text">{j.kind}</div>
                            <div className="truncate text-micro text-faint">
                              {j.id}
                              {typeof j.done === 'number' && typeof j.total === 'number' ? ` · ${j.done}/${j.total}` : ''}
                              {j.error ? ` · ${j.error}` : ''}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted">
                          <span>{fmtTime(j.finishedAt ?? j.startedAt)}</span>
                          {j.status === 'running' && (
                            <Button variant="ghost" size="sm" onClick={() => void stopScan(j.id)}>
                              <Square size={11} /> Stop
                            </Button>
                          )}
                        </div>
                      </div>
                      {pct != null && (
                        <div className="mt-2.5">
                          <div className="mb-1 flex items-center justify-between text-micro text-faint">
                            <span>{j.status === 'running' ? 'Testing nodes' : 'Finished'}</span>
                            <span>{pct}%</span>
                          </div>
                          <Progress value={pct} />
                        </div>
                      )}
                    </RowCard>
                  );
                })}
              </div>
            )}
          </Section>
        </TabPanel>

        {/* ----------------------------- endpoints ----------------------------- */}
        <TabPanel value="endpoints">
          <Section
            title="Test endpoints"
            icon={<Globe size={15} />}
            subtitle="URLs used to validate that a proxy node can actually reach the open internet — a node that cannot fetch one of these has not been proven usable"
            collapsible
            pinned
            id="endpoints"
            badge={<Badge tone={endpoints.length > 0 ? 'neutral' : 'warn'}>{endpoints.length} configured</Badge>}
          >
            {endpoints.length === 0 ? (
              <EmptyState
                icon={<Globe size={22} />}
                title="No test endpoints"
                message="Add one below (e.g. https://www.gstatic.com/generate_204). Without an endpoint, proxy-mode tests have nothing to prove against."
              />
            ) : (
              <div className="space-y-2.5">
                {endpoints.map((e) => (
                  <RowCard key={e.id}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-text">{e.name}</div>
                        <div className="truncate font-mono text-micro text-faint">{e.url}</div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge tone={e.enabled ? 'ok' : 'neutral'}>{e.enabled ? 'enabled' : 'disabled'}</Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger"
                          aria-label={`Delete endpoint ${e.name}`}
                          onClick={() => void deleteEndpoint(e.id)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </div>
                  </RowCard>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Add an endpoint"
            icon={<Plus size={15} />}
            collapsible
            defaultOpen={false}
            id="add-endpoint"
            summary="Name + URL (a 204 endpoint is ideal)"
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Name">
                <input
                  value={teName}
                  onChange={(e) => setTeName(e.target.value)}
                  placeholder="Google 204"
                  className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-text placeholder:text-faint focus:border-accent/80 focus:outline-none"
                />
              </Field>
              <Field label="URL" hint="A 204 or small body is ideal — the probe only needs to prove connectivity.">
                <input
                  value={teUrl}
                  onChange={(e) => setTeUrl(e.target.value)}
                  placeholder="https://www.gstatic.com/generate_204"
                  className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 font-mono text-xs text-text placeholder:text-faint focus:border-accent/80 focus:outline-none"
                />
              </Field>
            </div>
            <Button
              variant="primary"
              onClick={() => void addEndpoint()}
              loading={addingTe}
              disabled={!teName.trim() || !teUrl.trim()}
              className="mt-3"
            >
              Add endpoint
            </Button>
          </Section>
        </TabPanel>
      </Tabs>

      <FoldNote id="untrusted-input" label="Where these nodes come from, and why that is safe" className="mt-4">
        <span className="flex items-start gap-1.5">
          <Globe size={12} className="mt-0.5 shrink-0" />
          Source content is untrusted input: URLs are validated (https, public hosts only), configs are parsed
          defensively, and fetched data never executes. Latencies shown anywhere in the app come from real probes run
          by the local cores.
        </span>
      </FoldNote>
    </DisclosureScope>
  );
}
