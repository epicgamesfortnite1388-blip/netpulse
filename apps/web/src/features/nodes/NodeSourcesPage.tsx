import { useCallback, useEffect, useState } from 'react';

import { useNavigate } from 'react-router';
import {
  Database,
  Download,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Radar,
  Square,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { fmtMs } from '@/lib/format';
import { usePersistentId, usePersistentState } from '@/lib/usePersistentState';

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

export default function NodeSourcesPage() {
  const toast = useToast();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [jobs, setJobs] = useState<ScanJobRow[]>([]);
  const [endpoints, setEndpoints] = useState<TestEndpointRow[]>([]);

  // Add-source form — inputs persist across tab switches (fetches take ~10-50s
  // and users routinely jump to another page mid-fetch).
  const [formName, setFormName] = usePersistentState<string>('sources.formName', '');
  const [formUrls, setFormUrls] = usePersistentState<string>('sources.formUrls', '');
  const [adding, setAdding] = useState(false);

  // Test-endpoint form
  const [teName, setTeName] = usePersistentState<string>('sources.teName', '');
  const [teUrl, setTeUrl] = usePersistentState<string>('sources.teUrl', '');
  const [addingTe, setAddingTe] = useState(false);

  const [scanning, setScanning] = useState(false);

  // In-flight fetch (source id) — persisted so the spinner + "fetching" badge
  // survive navigating away and back; the fetch itself runs server-side.
  const [fetchingId, setFetchingId] = usePersistentId('sources.fetchingId');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [src, jobRes, te] = await Promise.all([
        api.get<{ sources: SourceRow[]; total: number }>('/sources'),
        api.get<{ jobs: ScanJobRow[] }>('/scanner/jobs?limit=10'),
        api.get<{ endpoints: TestEndpointRow[] }>('/test-endpoints'),
      ]);
      setSources(src.sources ?? []);
      setJobs(jobRes.jobs ?? []);
      setEndpoints(te.endpoints ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addSource = async () => {
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
      await load();
    } catch (err) {
      toast('error', 'Could not add source', err instanceof Error ? err.message : undefined);
    } finally {
      setAdding(false);
    }
  };

  const fetchSource = async (id: string, name: string) => {
    setFetchingId(id);
    try {
      const res = await api.post<{ imported?: number; duplicates?: number; invalid?: number }>(
        `/sources/${encodeURIComponent(id)}/fetch`,
        {},
      );
      toast(
        'ok',
        `Fetched "${name}"`,
        `${res.imported ?? 0} imported · ${res.duplicates ?? 0} duplicates · ${res.invalid ?? 0} invalid`,
      );
      await load();
    } catch (err) {
      toast('error', `Fetch failed for "${name}"`, err instanceof Error ? err.message : undefined);
    } finally {
      setFetchingId(null);
    }
  };

  const toggleSource = async (id: string, enabled: boolean) => {
    try {
      await api.patch(`/sources/${encodeURIComponent(id)}`, { enabled });
      await load();
    } catch (err) {
      toast('error', 'Could not update source', err instanceof Error ? err.message : undefined);
    }
  };

  const deleteSource = async (id: string, name: string) => {
    try {
      await api.delete(`/sources/${encodeURIComponent(id)}`);
      toast('ok', `Source "${name}" removed`);
      await load();
    } catch (err) {
      toast('error', 'Could not remove source', err instanceof Error ? err.message : undefined);
    }
  };

  const startScan = async (kind: 'test' | 'deep-test' | 'health-check') => {
    setScanning(true);
    try {
      const res = await api.post<{ jobId?: string }>('/scanner/start', { kind });
      toast('ok', 'Scan started', res.jobId ? `Job ${res.jobId}` : undefined);
      await load();
    } catch (err) {
      toast('error', 'Could not start scan', err instanceof Error ? err.message : undefined);
    } finally {
      setScanning(false);
    }
  };

  const stopScan = async (jobId: string) => {
    try {
      await api.post(`/scanner/stop/${encodeURIComponent(jobId)}`, {});
      toast('ok', 'Scan cancelled');
      await load();
    } catch (err) {
      toast('error', 'Could not stop scan', err instanceof Error ? err.message : undefined);
    }
  };

  const addEndpoint = async () => {
    if (!teName.trim() || !teUrl.trim()) return;
    setAddingTe(true);
    try {
      await api.post('/test-endpoints', { name: teName.trim(), url: teUrl.trim() });
      toast('ok', 'Test endpoint added');
      setTeName('');
      setTeUrl('');
      await load();
    } catch (err) {
      toast('error', 'Could not add endpoint', err instanceof Error ? err.message : undefined);
    } finally {
      setAddingTe(false);
    }
  };

  const deleteEndpoint = async (id: string) => {
    try {
      await api.delete(`/test-endpoints/${encodeURIComponent(id)}`);
      await load();
    } catch (err) {
      toast('error', 'Could not remove endpoint', err instanceof Error ? err.message : undefined);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-base text-foreground">
        <LoadingState label="Loading sources & scans…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen bg-base text-foreground">
        <ErrorState error={error} retry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base text-foreground">
      {/* Sources */}
      <Card>
        <CardHeader
          title="Node sources"
          subtitle="Public V2Ray/Xray subscription sources discovered, fetched and imported into the node database"
          actions={
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                <RefreshCw size={13} /> Refresh
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate('/nodes')}>
                Browse nodes
              </Button>
            </div>
          }
        />
        <CardBody className="space-y-4">
          {sources.length === 0 ? (
            <EmptyState
              icon={<Globe size={22} />}
              title="No sources yet"
              message="Add a subscription URL below to start discovering public proxy configs."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted border-b border-line">
                    <th className="py-2 pr-3">Source</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Discovered</th>
                    <th className="py-2 pr-3">Imported</th>
                    <th className="py-2 pr-3">Last fetch</th>
                    <th className="py-2 pr-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id} className="border-b border-line/50">
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <Database size={13} className="text-muted shrink-0" />
                          <div>
                            <div className="font-medium">{s.name}</div>
                            <div className="text-xs text-faint truncate max-w-[240px]">{s.urls[0]}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge
                          tone={
                            s.status === 'ok' || s.status === 'healthy'
                              ? 'ok'
                              : s.status === 'error' || s.status === 'failed'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {s.enabled ? (s.status ?? 'idle') : 'disabled'}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs">{s.discoveredConfigCount ?? '—'}</td>
                      <td className="py-2.5 pr-3 font-mono text-xs">{s.importedConfigCount ?? '—'}</td>
                      <td className="py-2.5 pr-3 text-xs text-muted">{fmtTime(s.lastFetch)}</td>
                      <td className="py-2.5 pr-3">
                        <div className="flex justify-end gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => void fetchSource(s.id, s.name)} disabled={fetchingId != null}>
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
                            onClick={() => void deleteSource(s.id, s.name)}
                            title="Delete source (built-in sources cannot be deleted)"
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Add source form */}
          <div className="rounded-lg border border-line bg-surface-2 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Plus size={14} /> Add source
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Name">
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Community subscriptions"
                  className="w-full rounded-lg border border-line bg-base px-3 py-2 text-sm focus:border-accent/50 focus:outline-none"
                />
              </Field>
              <Field label="Subscription URLs (one per line)">
                <textarea
                  value={formUrls}
                  onChange={(e) => setFormUrls(e.target.value)}
                  rows={2}
                  placeholder={'https://raw.githubusercontent.com/…/Sub1.txt'}
                  className="w-full rounded-lg border border-line bg-base px-3 py-2 font-mono text-xs focus:border-accent/50 focus:outline-none"
                />
              </Field>
            </div>
            <Button variant="primary" size="sm" loading={adding} disabled={!formName.trim() || !formUrls.trim()} onClick={() => void addSource()}>
              Add source
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Scanner jobs */}
      <Card className="mt-6">
        <CardHeader
          title="Node scanner"
          subtitle="Batch TCP/TLS/proxy testing of discovered nodes with bounded concurrency and cancellation"
          actions={
            <div className="flex gap-2">
              <Button variant="primary" size="sm" loading={scanning} onClick={() => void startScan('test')} disabled={endpoints.length === 0 && sources.length === 0}>
                <Radar size={13} /> Quick test
              </Button>
              <Button variant="ghost" size="sm" loading={scanning} onClick={() => void startScan('health-check')}>
                Health check
              </Button>
              <Button variant="ghost" size="sm" loading={scanning} onClick={() => void startScan('deep-test')}>
                Deep test
              </Button>
            </div>
          }
        />
        <CardBody>
          {jobs.length === 0 ? (
            <EmptyState icon={<Radar size={22} />} title="No scan jobs yet" message="Start a scan to batch-test the nodes in your database." />
          ) : (
            <div className="space-y-2">
              {jobs.map((j) => (
                <div key={j.id} className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <Badge tone={j.status === 'running' ? 'warn' : j.status === 'completed' ? 'ok' : j.status === 'cancelled' ? 'neutral' : 'danger'}>
                      {j.status}
                    </Badge>
                    <div>
                      <div className="text-sm font-medium font-mono">{j.kind}</div>
                      <div className="text-xs text-faint">
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
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Test endpoints */}
      <Card className="mt-6">
        <CardHeader
          title="Test endpoints"
          subtitle="URLs used to validate that a proxy node can actually reach the open internet"
        />
        <CardBody className="space-y-4">
          {endpoints.length === 0 ? (
            <EmptyState icon={<Globe size={22} />} title="No test endpoints" message="Add one below (e.g. https://www.gstatic.com/generate_204)." />
          ) : (
            <div className="space-y-2">
              {endpoints.map((e) => (
                <div key={e.id} className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-4 py-2.5">
                  <div>
                    <div className="text-sm font-medium">{e.name}</div>
                    <div className="text-xs text-faint font-mono">{e.url}</div>
                  </div>
                  <Button variant="ghost" size="sm" className="text-danger" onClick={() => void deleteEndpoint(e.id)}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="rounded-lg border border-line bg-surface-2 p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Name">
                <input
                  value={teName}
                  onChange={(e) => setTeName(e.target.value)}
                  placeholder="Google 204"
                  className="w-full rounded-lg border border-line bg-base px-3 py-2 text-sm focus:border-accent/50 focus:outline-none"
                />
              </Field>
              <Field label="URL">
                <input
                  value={teUrl}
                  onChange={(e) => setTeUrl(e.target.value)}
                  placeholder="https://www.gstatic.com/generate_204"
                  className="w-full rounded-lg border border-line bg-base px-3 py-2 font-mono text-xs focus:border-accent/50 focus:outline-none"
                />
              </Field>
            </div>
            <Button variant="primary" size="sm" loading={addingTe} disabled={!teName.trim() || !teUrl.trim()} onClick={() => void addEndpoint()}>
              Add endpoint
            </Button>
          </div>
        </CardBody>
      </Card>

      <p className="px-6 py-4 text-xs text-faint">
        Source content is untrusted input: URLs are validated (https, public hosts only), configs are parsed
        defensively, and fetched data never executes. Latencies shown elsewhere come from real probes
        {fmtMs(0) ? '' : ''}.
      </p>
    </div>
  );
}
