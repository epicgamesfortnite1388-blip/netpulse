import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Cloud,
  Crosshair,
  Eye,
  EyeOff,
  Gamepad2,
  Globe,
  History,
  Map as MapIcon,
  MapPinOff,
  Maximize2,
  Play,
  Radar,
  RefreshCw,
  Server,
  Shield,
  Trash2,
  Zap,
} from 'lucide-react';
import { useSearchParams } from 'react-router';

import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/Field';
import { Metric } from '@/components/ui/Metric';
import { EmptyState } from '@/components/ui/States';
import { Tooltip } from '@/components/ui/Tooltip';
import { api } from '@/lib/api';
import { GEO_STATUS_COPY, GeoTooltipBody, geoReasonOf } from '@/lib/geoStatus';
import { fmtMs, fmtPct, timeAgo } from '@/lib/format';
import { useWsTestProgress } from '@/lib/ws';
import { MapCanvas } from './MapCanvas';

import type { MapArc, MapNode, MapPath } from './MapCanvas';
import type { MapConnectionRow, MapLocalInfo, MapObservation, MapSweepResult, NetworkTarget } from '@netpulse/shared';
import type { WsTestMessage } from '@/lib/ws';

interface TargetsResponse {
  targets: NetworkTarget[];
}

interface ObservationsResponse {
  observations: MapObservation[];
  total: number;
}

interface CompareResponse {
  targetId: string;
  compared: boolean;
  note?: string;
  current?: MapObservation;
  previous?: MapObservation | null;
  diff?: {
    changed: boolean;
    changes: string[];
    latencyDeltaMs: number | null;
    insight: string | null;
  };
  directVpn?: { directMs: number | null; vpnMs: number | null; verdict: string } | null;
}

type FilterKey = 'all' | 'dns' | 'game' | 'gaming' | 'cloudflare' | 'vpn' | 'vps' | 'custom' | 'route';
type MetricKey = 'latency' | 'jitter' | 'loss';
type TimeWindow = 'live' | '1h' | '1d';

function typeForFilter(f: FilterKey): NetworkTarget['type'] | 'all' | 'route' {
  if (f === 'all' || f === 'route') return f;
  if (f === 'gaming') return 'game';
  return f;
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'route', label: 'Route' },
  { key: 'vpn', label: 'VPN' },
  { key: 'gaming', label: 'Gaming' },
  { key: 'dns', label: 'DNS' },
  { key: 'cloudflare', label: 'Cloudflare' },
  { key: 'vps', label: 'Servers' },
  { key: 'custom', label: 'Custom' },
];

const TYPE_ICON: Record<NetworkTarget['type'], React.ReactNode> = {
  internet: <Globe size={13} />,
  dns: <Radar size={13} />,
  game: <Gamepad2 size={13} />,
  cloudflare: <Cloud size={13} />,
  vpn: <Shield size={13} />,
  vps: <Server size={13} />,
  custom: <Crosshair size={13} />,
};

const STATUS_TONE: Record<MapObservation['status'], 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  excellent: 'ok',
  good: 'ok',
  fair: 'warn',
  poor: 'danger',
  unreachable: 'danger',
  unknown: 'neutral',
};

function maskIp(ip: string | null | undefined): string {
  if (!ip) return '—';
  if (ip.includes(':')) return 'masked:ipv6';
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.x.x.x` : 'masked';
}

function primaryLatency(obs: MapObservation): number | null {
  return obs.measurements.find((m) => m.method === 'tcp' || m.method === 'dns')?.latencyMs ?? obs.measurements[0]?.latencyMs ?? null;
}

function primaryLoss(obs: MapObservation): number | null {
  return obs.measurements.find((m) => m.method === 'tcp')?.lossPct ?? obs.measurements[0]?.lossPct ?? null;
}

function destinationGeo(obs: MapObservation): { lat: number; lon: number } | null {
  // The pin must be the DESTINATION's own geo — never a transit hop's.
  // Anycast / edge-fabric destinations are refused geo by the backend, so
  // they get no pin at all (the destination panel explains why); falling
  // back to the last geo-tagged transit hop painted a pin that was not the
  // destination (the Cloudflare-in-the-wrong-continent class of lie).
  const dest = obs.resolvedIp != null ? obs.hops.find((h) => h.ip === obs.resolvedIp) : undefined;
  return dest?.geo ? { lat: dest.geo.lat, lon: dest.geo.lon } : null;
}

function portLabel(obs: MapObservation): string {
  if (obs.port == null) return '—';
  const proto = obs.protocol?.toUpperCase() ?? 'TCP';
  return `${proto}/${obs.port}`;
}

export default function LiveMapPage() {
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>((searchParams.get('mode') as FilterKey) || 'all');
  const [metric, setMetric] = useState<MetricKey>('latency');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('live');
  const [privacy, setPrivacy] = useState(() => localStorage.getItem('map-privacy') === '1');
  const [presentation, setPresentation] = useState(() => localStorage.getItem('map-presentation') === '1');
  const [noc, setNoc] = useState(false);
  const [showConnections, setShowConnections] = useState(() => searchParams.get('connections') === '1');
  const [sweep, setSweep] = useState<MapSweepResult | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(searchParams.get('target'));
  const [observations, setObservations] = useState<Map<string, MapObservation>>(new Map());
  const [playback, setPlayback] = useState<MapObservation | null>(null);
  const [progress, setProgress] = useState<{ targetId: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // custom target inputs
  const [customHost, setCustomHost] = useState('');
  const [customProtocol, setCustomProtocol] = useState('tcp');
  const [customPort, setCustomPort] = useState('443');
  const [measuring, setMeasuring] = useState(false);

  // latency history per target (client-side session buffer)
  const historyRef = useRef<Map<string, { t: number; ms: number | null }[]>>(new Map());

  /* ------------------------------ data ----------------------------------- */

  const targetsQuery = useQuery({
    queryKey: ['map', 'targets'],
    queryFn: () => api.get<TargetsResponse>('/map/targets'),
    staleTime: 30_000,
  });
  const localQuery = useQuery({
    queryKey: ['map', 'local'],
    queryFn: () => api.get<MapLocalInfo>('/map/local'),
    refetchInterval: 15_000,
  });
  const observationsQuery = useQuery({
    queryKey: ['map', 'observations'],
    queryFn: () => api.get<ObservationsResponse>('/map/observations?limit=120'),
    refetchInterval: 20_000,
  });
  const connectionsQuery = useQuery({
    queryKey: ['map', 'connections'],
    queryFn: () => api.get<{ available: boolean; reason?: string; rows: MapConnectionRow[] }>('/map/connections'),
    enabled: showConnections,
    refetchInterval: showConnections ? 10_000 : false,
  });
  const compareQuery = useQuery({
    queryKey: ['map', 'compare', selectedTargetId],
    queryFn: () => api.get<CompareResponse>(`/map/compare?targetId=${encodeURIComponent(selectedTargetId!)}`),
    enabled: selectedTargetId != null,
  });
  const historyQuery = useQuery({
    queryKey: ['map', 'history', selectedTargetId],
    queryFn: () => api.get<ObservationsResponse>(`/map/observations?targetId=${encodeURIComponent(selectedTargetId!)}&limit=50`),
    enabled: selectedTargetId != null,
  });

  // hydrate from persisted observations
  useEffect(() => {
    const list = observationsQuery.data?.observations ?? [];
    if (list.length === 0) return;
    setObservations((prev) => {
      const next = new Map(prev);
      // The list is newest-first; keep the FIRST (newest) row per target —
      // a later row would silently resurrect stale observations.
      for (const obs of list) if (!next.has(obs.target.id)) next.set(obs.target.id, obs);
      return next;
    });
  }, [observationsQuery.data]);

  // live updates via WS on the shared 'map' topic
  const onWs = useCallback((msg: WsTestMessage) => {
    if (msg.type === 'map:observation' && msg.observation) {
      const obs = msg.observation as MapObservation;
      setObservations((prev) => {
        const next = new Map(prev);
        next.set(obs.target.id, obs);
        return next;
      });
      const h = historyRef.current.get(obs.target.id) ?? [];
      const latency = primaryLatency(obs);
      historyRef.current.set(obs.target.id, [...h.slice(-199), { t: obs.createdAt, ms: latency }]);
      setMeasuring(false);
      setProgress(null);
    } else if (msg.type === 'map:progress') {
      setProgress({ targetId: String(msg.targetId ?? ''), message: msg.message ?? '' });
    } else if (msg.type === 'map:sweep' && msg.sweepId && msg.result) {
      const r = msg.result as MapSweepResult;
      setSweep(r);
      if (r.completed) setSweepBusy(false);
    } else if (msg.type === 'map:error') {
      setNotice(`Measurement failed: ${msg.message ?? 'unknown error'}`);
      setMeasuring(false);
      setProgress(null);
    }
  }, []);
  useWsTestProgress('map', onWs);

  /* ------------------------------ actions --------------------------------- */

  const measure = useCallback(
    async (targetId: string) => {
      setSelectedTargetId(targetId);
      setPlayback(null);
      setMeasuring(true);
      setNotice(null);
      try {
        await api.post<{ observationId: string }>('/map/measure', { targetId });
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Failed to start measurement');
        setMeasuring(false);
      }
    },
    [],
  );

  const measureCustom = useCallback(async () => {
    const host = customHost.trim();
    if (!host) {
      setNotice('Enter a hostname or IP to measure.');
      return;
    }
    const port = customProtocol === 'dns' ? 53 : Number(customPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setNotice('Destination port must be 1–65535.');
      return;
    }
    setMeasuring(true);
    setNotice(null);
    try {
      await api.post<{ observationId: string }>('/map/measure', {
        custom: { host, protocol: customProtocol, port, name: host },
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to start measurement');
      setMeasuring(false);
    }
  }, [customHost, customProtocol, customPort]);

  const clearHistory = useCallback(async () => {
    await api.post('/map/observations/clear');
    setObservations(new Map());
    setPlayback(null);
    void observationsQuery.refetch();
    void historyQuery.refetch();
  }, [observationsQuery, historyQuery]);

  const startSweep = useCallback(async () => {
    setSweepBusy(true);
    setNotice(null);
    setSweep({ sweepId: 'pending', sourceNote: null, startedAt: Date.now(), durationMs: null, rows: [], completed: false });
    try {
      const { sweepId } = await api.post<{ sweepId: string; accepted: number }>('/map/sweep', {});
      const poll = setInterval(() => {
        void api
          .get<{ sweep: MapSweepResult }>(`/map/sweep/${sweepId}`)
          .then((r) => {
            setSweep(r.sweep);
            if (r.sweep.completed) {
              clearInterval(poll);
              setSweepBusy(false);
            }
          })
          .catch(() => {
            clearInterval(poll);
            setSweepBusy(false);
            setNotice('Sweep tracking failed — the backend may have restarted.');
          });
      }, 1_500);
    } catch (err) {
      setSweep(null);
      setSweepBusy(false);
      setNotice(err instanceof Error ? err.message : 'Failed to start sweep');
    }
  }, []);

  const togglePrivacy = useCallback(() => {
    setPrivacy((v) => {
      localStorage.setItem('map-privacy', v ? '0' : '1');
      return !v;
    });
  }, []);

  const togglePresentation = useCallback(() => {
    setPresentation((v) => {
      localStorage.setItem('map-presentation', v ? '0' : '1');
      return !v;
    });
  }, []);

  /* ----------------------------- derived map ------------------------------ */

  const targets = targetsQuery.data?.targets ?? [];
  const local = localQuery.data ?? null;
  const selectedObs = selectedTargetId ? (observations.get(selectedTargetId) ?? null) : null;
  const obsForMap = playback ?? selectedObs;

  const hidden = privacy || presentation;

  const youNode: MapNode | null = useMemo(() => {
    if (local?.latitude == null || local.longitude == null) return null;
    return {
      id: 'you',
      label: hidden ? 'You' : local.city ?? 'You',
      sub: hidden ? null : local.publicIp,
      lat: local.latitude,
      lon: local.longitude,
      kind: 'you',
      status: 'good',
      latencyMs: null,
    };
  }, [local, hidden]);

  const nodes: MapNode[] = useMemo(() => {
    const list: MapNode[] = [];
    if (youNode) list.push(youNode);
    for (const obs of observations.values()) {
      const t = obs.target;
      const targetType = typeForFilter(filter);
      if (targetType !== 'all' && targetType !== 'route' && t.type !== targetType) continue;
      const geo = destinationGeo(obs);
      if (!geo) continue;
      const isPlayback = playback?.id === obs.id;
      list.push({
        id: obs.target.id,
        label: isPlayback ? `${t.name} (snapshot)` : t.name,
        sub: hidden ? null : obs.resolvedIp ?? undefined,
        lat: geo.lat,
        lon: geo.lon,
        kind: t.type === 'vpn' ? 'vpn' : 'target',
        status: obs.status,
        latencyMs: primaryLatency(obs),
        historical: isPlayback,
      });
    }
    return list;
  }, [youNode, observations, filter, hidden, playback]);

  const arcs: MapArc[] = useMemo(() => {
    if (!youNode) return [];
    const out: MapArc[] = [];
    for (const obs of observations.values()) {
      if (playback && playback.id === obs.id) continue; // rendered by the dedicated block below
      const geo = destinationGeo(obs);
      if (!geo) continue;
      out.push({
        id: obs.id,
        from: { lat: youNode.lat, lon: youNode.lon },
        to: { lat: geo.lat, lon: geo.lon },
        kind: obs.vpnActive ? 'vpn' : 'normal',
        latencyMs: primaryLatency(obs),
        lossPct: primaryLoss(obs),
        selected: obs.target.id === selectedTargetId,
      });
    }
    if (playback) {
      const geo = destinationGeo(playback);
      if (geo && youNode) {
        out.push({
          id: `playback:${playback.id}`,
          from: { lat: youNode.lat, lon: youNode.lon },
          to: { lat: geo.lat, lon: geo.lon },
          kind: 'historical',
          latencyMs: primaryLatency(playback),
          lossPct: primaryLoss(playback),
          selected: false,
        });
      }
    }
    return out;
  }, [youNode, observations, playback, selectedTargetId]);

  const paths: MapPath[] = useMemo(() => {
    if (!obsForMap) return [];
    const pts = obsForMap.hops
      .filter((h) => h.geo)
      .map((h) => ({ lat: h.geo!.lat, lon: h.geo!.lon }));
    if (pts.length < 2) return [];
    return [{ id: obsForMap.id, points: pts, label: obsForMap.target.name, historical: !!playback }];
  }, [obsForMap, playback]);

  const focus = useMemo(() => {
    if (noc) return null;
    if (obsForMap) {
      const geo = destinationGeo(obsForMap);
      if (geo) return geo;
    }
    if (youNode) return { lat: youNode.lat, lon: youNode.lon };
    return null;
  }, [obsForMap, youNode, noc]);

  /* ---------------------------- latency history ---------------------------- */

  const historySamples = useMemo(() => {
    const samples = selectedTargetId ? (historyRef.current.get(selectedTargetId) ?? []) : [];
    if (timeWindow === 'live') return samples;
    const cutoff = timeWindow === '1h' ? 3_600_000 : 86_400_000;
    const now = Date.now();
    return samples.filter((s) => now - s.t <= cutoff);
  }, [selectedTargetId, timeWindow]);

  const stats = useMemo(() => {
    const vals = historySamples.map((s) => s.ms).filter((v): v is number => v != null);
    if (vals.length === 0) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
    const jitter = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - avg) ** 2, 0) / (vals.length - 1)) : 0;
    return {
      min: sorted[0] ?? null,
      max: sorted[sorted.length - 1] ?? null,
      median: sorted[Math.floor(sorted.length / 2)] ?? null,
      avg,
      p95,
      jitter,
      loss: selectedObs ? primaryLoss(selectedObs) : null,
    };
  }, [historySamples, selectedObs]);

  /* ------------------------------ playback --------------------------------- */

  useEffect(() => {
    if (timeWindow === 'live') {
      setPlayback(null);
      return;
    }
    const list = historyQuery.data?.observations ?? [];
    if (list.length === 0) return;
    const cutoff = timeWindow === '1h' ? Date.now() - 3_600_000 : Date.now() - 86_400_000;
    const eligible = list.filter((o) => o.createdAt <= cutoff);
    const pick = eligible[0] ?? list[list.length - 1];
    if (pick && pick.id !== playback?.id) setPlayback(pick);
    // intentional: playback?.id is only read as a set-once guard; adding it
    // would re-run (and re-pick) the observation whenever playback changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeWindow, historyQuery.data]);

  /* ------------------------------- deep links ------------------------------ */

  useEffect(() => {
    const target = searchParams.get('target');
    if (target && targets.length > 0 && !selectedTargetId) setSelectedTargetId(target);
    if (searchParams.get('run') === '1' && target && targets.some((t) => t.id === target)) void measure(target);
    // deep-link run fires once per navigation; measure() identity is stable via
    // its own deps, re-running on it would double-fire measurements
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, targets]);

  /* ------------------------------- rendering ------------------------------- */

  const content = (
    <div className="space-y-5">
      {/* status strip */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${measuring ? 'animate-pulse bg-accent' : 'bg-ok'}`} />
          {measuring ? 'Measuring…' : 'Monitoring'}
        </span>
        <Badge tone={local?.vpn.connected ? 'ok' : 'neutral'}>
          <Shield size={11} className="mr-1 inline" />
          VPN {local?.vpn.connected ? (hidden ? 'connected' : `· ${local.vpn.serverName ?? local.vpn.providerId}`) : 'disconnected'}
        </Badge>
        <span className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
          Public IP: <span className="font-mono">{hidden ? maskIp(local?.publicIp) : local?.publicIp ?? '…'}</span>
        </span>
        {stats && (
          <>
            <span className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
              Latency: <span className="font-mono text-text">{fmtMs(stats.median)}</span>
            </span>
            <span className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
              Loss: <span className="font-mono text-text">{fmtPct(stats.loss)}</span>
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={togglePrivacy} title="Privacy mode — redacts IPs and hostnames">
            {privacy ? <EyeOff size={13} className="text-accent" /> : <Eye size={13} />}
            {privacy ? 'Privacy on' : 'Privacy'}
          </Button>
          <Button variant="ghost" size="sm" onClick={togglePresentation} title="Presentation mode — keeps cities/latency/ASN, redacts IPs">
            <Maximize2 size={13} />
            {presentation ? 'Presentation on' : 'Presentation'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowConnections((v) => !v)} title="Local active connections">
            <Activity size={13} />
            Connections
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setNoc(true)} title="Fullscreen NOC mode">
            <Maximize2 size={13} />
            NOC
          </Button>
          <Button variant="ghost" size="sm" onClick={clearHistory} title="Delete all map history">
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      {privacy && (
        <p className="text-[11px] text-faint">
          Privacy mode: IP addresses and hostnames are redacted. Geography, latency and ASN labels stay visible.
        </p>
      )}
      {presentation && (
        <p className="text-[11px] text-faint">
          Presentation mode: IP addresses are redacted for safe sharing; cities, latency, routes and ASN labels are preserved.
        </p>
      )}
      {notice && <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">{notice}</p>}

      {/* toolbar */}
      <Card>
        <CardBody className="flex flex-wrap items-center gap-2.5">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  filter === f.key ? 'bg-accent/15 text-accent-strong' : 'text-faint hover:bg-surface-2 hover:text-muted'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="mx-1 h-5 w-px bg-line" />
          <Select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} className="h-8 w-28 text-xs">
            <option value="latency">Latency</option>
            <option value="jitter">Jitter</option>
            <option value="loss">Loss</option>
          </Select>
          <Select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value as TimeWindow)} className="h-8 w-24 text-xs">
            <option value="live">Live</option>
            <option value="1h">1 hour ago</option>
            <option value="1d">Yesterday</option>
          </Select>
          <div className="mx-1 h-5 w-px bg-line" />
          <Field label="Custom target">
            <div className="flex items-center gap-1.5">
              <Input value={customHost} onChange={(e) => setCustomHost(e.target.value)} placeholder="host or IP" className="h-8 w-44 text-xs" />
              <Select value={customProtocol} onChange={(e) => setCustomProtocol(e.target.value)} className="h-8 w-20 text-xs">
                <option value="tcp">tcp</option>
                <option value="tls">tls</option>
                <option value="https">https</option>
                <option value="udp">udp</option>
                <option value="dns">dns</option>
              </Select>
              <Input
                value={customProtocol === 'dns' ? '53' : customPort}
                onChange={(e) => setCustomPort(e.target.value)}
                disabled={customProtocol === 'dns'}
                className="h-8 w-16 text-xs"
                placeholder="port"
              />
              <Button variant="primary" size="sm" onClick={() => void measureCustom()} loading={measuring}>
                <Play size={12} />
                Measure
              </Button>
            </div>
          </Field>
        </CardBody>
      </Card>

      {/* map + side panels */}
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <Card className="overflow-hidden">
          <CardHeader
            title="Global network map"
            subtitle="Measured routes, real geography confidence, live latency"
            icon={<MapIcon size={15} />}
            actions={
              selectedObs && (
                <Badge tone={STATUS_TONE[selectedObs.status]}>
                  {selectedObs.statusLabel} {primaryLatency(selectedObs) != null ? `· ${fmtMs(primaryLatency(selectedObs))}` : ''}
                </Badge>
              )
            }
          />
          <CardBody className="p-0">
            <div className="relative h-[560px]">
              <MapCanvas
                nodes={nodes}
                arcs={arcs}
                paths={paths}
                focus={focus}
                focusKey={selectedTargetId}
                privacy={hidden}
                reducedMotion={reducedMotion}
                onSelect={(node) => {
                  if (node && node.id !== 'you') setSelectedTargetId(node.id);
                }}
              />
              {progress && (
                <div className="absolute left-3 top-3 rounded-lg border border-accent/30 bg-bg/85 px-3 py-2 text-xs text-accent backdrop-blur">
                  {progress.message}
                </div>
              )}
              {playback && (
                <div className="absolute right-3 top-3 rounded-lg border border-line bg-bg/85 px-3 py-2 text-[11px] text-faint backdrop-blur">
                  Showing snapshot from <span className="text-muted">{timeAgo(playback.createdAt)}</span> — historical, not live
                </div>
              )}
              <div className="absolute bottom-3 left-3 rounded-lg border border-line bg-bg/85 px-3 py-2 text-[10px] leading-relaxed text-faint backdrop-blur">
                <span className="text-accent">●</span> measured · <span className="text-warn">●</span> through VPN · <span className="text-faint">●</span> historical
                <br />
                Node positions: known endpoints (Cloudflare colo) vs country-level GeoIP estimates — never exact router locations.
              </div>
            </div>
          </CardBody>
        </Card>

        {/* right inspector */}
        <div className="space-y-5">
          {!selectedTargetId && (
            <EmptyState icon={<Crosshair size={18} />} title="Select a target" message="Choose a target on the left (or below) to measure, trace and inspect its route." />
          )}

          {/* target picker */}
          <Card>
            <CardHeader title="Targets" subtitle={`${targets.length} from DNS / gaming / Cloudflare / VPN / servers`} />
            <CardBody className="max-h-72 overflow-auto">
              {targetsQuery.isLoading && <p className="text-xs text-faint">Loading targets…</p>}
              <ul className="space-y-0.5">
                {targets
                  .filter((t) => {
                    const targetType = typeForFilter(filter);
                    return targetType === 'all' || targetType === 'route' || t.type === targetType;
                  })
                  .map((t) => {
                    const obs = observations.get(t.id);
                    return (
                      <li key={t.id}>
                        <button
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 ${
                            selectedTargetId === t.id ? 'bg-accent-soft text-accent-strong' : 'text-muted'
                          }`}
                          onClick={() => setSelectedTargetId(t.id)}
                        >
                          <span className="shrink-0 text-faint">{TYPE_ICON[t.type]}</span>
                          <span className="min-w-0 flex-1 truncate">{t.name}</span>
                          {obs ? (
                            <span className={`shrink-0 font-mono text-[11px] ${obs.status === 'excellent' || obs.status === 'good' ? 'text-ok' : obs.status === 'fair' ? 'text-warn' : 'text-danger'}`}>
                              {primaryLatency(obs) != null ? `${Math.round(primaryLatency(obs)!)} ms` : obs.statusLabel}
                            </span>
                          ) : (
                            <Button variant="ghost" size="sm" className="shrink-0" onClick={(e) => { e.stopPropagation(); void measure(t.id); }} loading={measuring && selectedTargetId === t.id}>
                              <Play size={11} />
                            </Button>
                          )}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </CardBody>
          </Card>

          {selectedObs && (
            <>
              <Card>
                <CardHeader
                  title="Destination"
                  actions={<Badge tone={STATUS_TONE[selectedObs.status]}>{selectedObs.statusLabel}</Badge>}
                />
                <CardBody className="space-y-2 text-[13px]">
                  <Row label="Target" value={selectedObs.target.name} />
                  <Row label="Hostname" value={hidden ? 'redacted' : selectedObs.target.host} mono />
                  <Row label="Resolved IP" value={hidden ? maskIp(selectedObs.resolvedIp) : selectedObs.resolvedIp} mono />
                  {(() => {
                    // Destination geo confidence — the map never shows false
                    // precision: surface HOW we know where this pin is, and
                    // when there is no pin, WHY (anycast / edge fabric / no
                    // evidence) instead of a bare Unknown.
                    const withGeo = selectedObs.hops.filter((h) => h.geo);
                    const geo = withGeo[withGeo.length - 1]?.geo;
                    if (geo) return <Row label="Location" value={`${geo.confidence.label} (${geo.confidence.confidence})`} />;
                    if (selectedObs.destGeoReason != null) {
                      const reason = geoReasonOf(selectedObs.destGeoReason, false);
                      const copy = GEO_STATUS_COPY[reason];
                      return (
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-[11px] uppercase tracking-wider text-faint">Location</span>
                          <Tooltip content={<GeoTooltipBody reason={reason} />}>
                            <span className="flex cursor-help items-center gap-1 text-right text-warn">
                              <MapPinOff size={11} className="shrink-0" />
                              <span className="text-xs">{copy.title}</span>
                            </span>
                          </Tooltip>
                        </div>
                      );
                    }
                    return <Row label="Location" value="Unknown — no geolocation evidence" />;
                  })()}
                  <Row label="Protocol / Port" value={portLabel(selectedObs)} mono />
                  <Row label="Address family" value={`IPv${selectedObs.family}`} />
                  {selectedObs.vpnActive && <Row label="Path" value={`Through VPN${selectedObs.vpnLabel ? ` (${hidden ? 'tunnel' : selectedObs.vpnLabel})` : ''}`} />}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {selectedObs.measurements.map((m) => (
                      <span key={m.method} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-muted">
                        {m.method.toUpperCase()} {m.port != null ? `:${m.port}` : ''} · {m.latencyMs != null ? `${m.latencyMs.toFixed(1)} ms` : '—'}
                      </span>
                    ))}
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Measurements" subtitle="Median of real probe samples — method and port are shown, never assumed" />
                <CardBody className="space-y-2">
                  {selectedObs.measurements.map((m) => (
                    <div key={m.method} className="flex items-center justify-between rounded-lg border border-line/40 bg-surface-2/50 px-3 py-2 text-xs">
                      <div>
                        <div className="font-medium text-muted">{m.method.toUpperCase()}</div>
                        <div className="font-mono text-[10px] text-faint">
                          {m.protocol.toUpperCase()}
                          {m.port != null ? `/${m.port}` : ''} · {m.samples} samples{m.jitterMs != null ? ` · ±${m.jitterMs.toFixed(1)} ms jitter` : ''}
                          {m.lossPct != null ? ` · ${fmtPct(m.lossPct)} loss` : ''}
                        </div>
                      </div>
                      <span className={`font-mono ${m.ok ? 'text-text' : 'text-danger'}`}>{m.latencyMs != null ? `${m.latencyMs.toFixed(1)} ms` : m.error ?? 'failed'}</span>
                    </div>
                  ))}
                  {selectedObs.measurements.length === 0 && <p className="text-xs text-faint">No probes ran (no port configured).</p>}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Route" subtitle={`${selectedObs.hops.length} hops · ${portLabel(selectedObs)} · IPv${selectedObs.family}`} />
                <CardBody className="max-h-72 overflow-auto">
                  {selectedObs.hops.length === 0 && (
                    <p className="text-xs text-faint">Traceroute did not return hops (probe failed or filtered).</p>
                  )}
                  <ol className="space-y-1.5">
                    {selectedObs.hops.map((h) => (
                      <li key={h.hop} className="rounded-lg border border-line/40 bg-surface-2/40 px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                            <span className="text-faint">{h.hop}.</span>
                            <span className={h.ip ? 'text-text' : 'text-faint'}>
                              {h.ip == null ? 'no response' : hidden ? maskIp(h.ip) : h.ip}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-muted">{h.latencyMs != null ? `${h.latencyMs.toFixed(0)} ms` : '—'}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-faint">
                          {h.hostname && !hidden && <span className="truncate">{h.hostname}</span>}
                          {h.asn != null && <span className="font-mono">AS{h.asn}</span>}
                          {h.org && <span className="truncate">{h.org}</span>}
                          {h.country && <span>{h.country}</span>}
                          {h.geo && (
                            <span className="text-accent/80" title={h.geo.confidence.label}>
                              {h.geo.confidence.source === 'known-endpoint' ? `known · ${h.geo.city ?? ''}` : 'approx.'} ({h.geo.confidence.confidence})
                            </span>
                          )}
                          {(h.packetLoss ?? 0) > 0 && <span className="text-warn">{fmtPct(h.packetLoss)} loss</span>}
                          {h.latencyMs == null && <span>ICMP filtered or deprioritized — not proof of loss</span>}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {selectedObs.hops.length > 0 && (
                    <p className="mt-2 text-[10px] leading-relaxed text-faint">
                      Hop geography is a confidence-aware estimate: known endpoints are high-confidence; other hops use
                      country-level GeoIP. A timeout does not mean an outage, and hops are not necessarily physical routers.
                    </p>
                  )}
                </CardBody>
              </Card>
            </>
          )}
        </div>
      </div>

      {/* bottom: latency graph + stats */}
      {selectedObs && (
        <Card>
          <CardHeader
            title="Live latency graph"
            subtitle={`${selectedObs.target.name} — ${portLabel(selectedObs)}${selectedObs.vpnActive ? ' · through VPN' : ''}`}
            actions={
              <div className="flex gap-1 text-[11px]">
                {(['live', '1h', '1d'] as const).map((w) => (
                  <button
                    key={w}
                    onClick={() => setTimeWindow(w)}
                    className={`rounded px-2 py-0.5 ${timeWindow === w ? 'bg-accent/15 text-accent' : 'text-faint hover:text-muted'}`}
                  >
                    {w === 'live' ? 'Session' : w === '1h' ? '1 hour' : '1 day'}
                  </button>
                ))}
              </div>
            }
          />
          <CardBody>
            <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
              <div>
                <LatencyChart data={historySamples} height={170} />
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-2">
                <Metric label="Min" value={stats?.min ?? null} unit="ms" />
                <Metric label="Median" value={stats?.median ?? null} unit="ms" status="good" />
                <Metric label="Avg" value={stats?.avg ?? null} unit="ms" />
                <Metric label="p95" value={stats?.p95 ?? null} unit="ms" />
                <Metric label="Max" value={stats?.max ?? null} unit="ms" />
                <Metric label="Jitter" value={stats?.jitter ?? null} unit="ms" />
                <Metric label="Loss" value={stats?.loss ?? null} unit="pct" />
                <Metric label="Samples" value={historySamples.length} />
              </div>
            </div>
            {stats && stats.median != null && (
              <p className="mt-2 text-[11px] text-faint">
                Median {fmtMs(stats.median)} across {historySamples.length} sample(s). Method and port are visible per measurement —
                TCP RTT is never labeled as ICMP ping.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {/* compare / route change */}
      {selectedTargetId && compareQuery.data?.compared && (
        <Card>
          <CardHeader title="Route comparison" subtitle="Latest two observations of this target" icon={<History size={15} />} />
          <CardBody className="space-y-2 text-[13px]">
            {compareQuery.data.directVpn && (
              <div className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-muted">
                {compareQuery.data.directVpn.verdict}{' '}
                {compareQuery.data.directVpn.directMs != null && compareQuery.data.directVpn.vpnMs != null && (
                  <span className="font-mono text-text">
                    Direct {compareQuery.data.directVpn.directMs} ms · VPN {compareQuery.data.directVpn.vpnMs} ms
                  </span>
                )}
              </div>
            )}
            {(compareQuery.data.diff?.changes ?? []).length === 0 && (
              <p className="text-xs text-faint">No route change detected between the last two measurements.</p>
            )}
            {(compareQuery.data.diff?.changes ?? []).map((c, i) => (
              <p key={i} className="flex gap-2 text-xs text-muted">
                <Zap size={13} className="mt-0.5 shrink-0 text-warn" />
                {c}
              </p>
            ))}
            {compareQuery.data.diff?.insight && (
              <p className="rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-faint">{compareQuery.data.diff.insight}</p>
            )}
            <Button variant="secondary" size="sm" onClick={() => void compareQuery.refetch()}>
              <RefreshCw size={12} />
              Re-check
            </Button>
          </CardBody>
        </Card>
      )}

      {/* game-server sweep */}
      <Card>
        <CardHeader
          title="Game server sweep"
          subtitle="ICMP-first pings across every game/VPN/Cloudflare target, ranked — TCP fallback when ICMP is filtered"
          icon={<Zap size={15} />}
          actions={
            <Button variant="primary" size="sm" onClick={() => void startSweep()} loading={sweepBusy}>
              <Play size={12} />
              {sweepBusy ? 'Sweeping…' : 'Run sweep'}
            </Button>
          }
        />
        <CardBody>
          {!sweep && (
            <p className="text-xs text-faint">
              One click pings every target server-side with bounded concurrency: 4 ICMP samples per host, TCP-connect fallback,
              ranked fastest-first. Results stream in live as they land.
            </p>
          )}
          {sweep && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                <span className={`h-1.5 w-1.5 rounded-full ${sweep.completed ? 'bg-ok' : 'animate-pulse bg-accent'}`} />
                {sweep.completed ? `Completed in ${((sweep.durationMs ?? 0) / 1000).toFixed(1)}s ·` : 'Running…'}
                {sweep.rows.length} result(s)
                {sweep.sourceNote && <span className="text-faint">· {sweep.sourceNote}</span>}
              </div>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-surface-1 text-left text-[10px] uppercase tracking-wider text-faint">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">#</th>
                      <th className="py-1.5 pr-3 font-medium">Target</th>
                      <th className="py-1.5 pr-3 font-medium">Latency</th>
                      <th className="py-1.5 pr-3 font-medium">Jitter</th>
                      <th className="py-1.5 pr-3 font-medium">Loss</th>
                      <th className="py-1.5 pr-3 font-medium">Method</th>
                      <th className="py-1.5 pr-3 font-medium">Country</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {sweep.rows.map((r, i) => (
                      <tr key={r.target.id} className="border-b border-line/40 last:border-0">
                        <td className="py-1.5 pr-3 font-mono text-faint">{i + 1}</td>
                        <td className="max-w-56 truncate py-1.5 pr-3">
                          <span className="mr-1.5 inline-block align-middle text-faint">{TYPE_ICON[r.target.type]}</span>
                          {r.target.name}
                          {r.error && <span className="ml-1.5 text-[10px] text-warn">{r.error}</span>}
                        </td>
                        <td className={`py-1.5 pr-3 font-mono ${r.status === 'excellent' || r.status === 'good' ? 'text-ok' : r.status === 'fair' ? 'text-warn' : 'text-danger'}`}>
                          {r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : '—'}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-muted">{r.jitterMs != null ? `±${r.jitterMs.toFixed(1)}` : '—'}</td>
                        <td className="py-1.5 pr-3 font-mono text-muted">{r.lossPct != null ? fmtPct(r.lossPct) : '—'}</td>
                        <td className="py-1.5 pr-3 text-[10px] uppercase tracking-wide text-faint">{r.method ?? 'n/a'}</td>
                        <td className="py-1.5 pr-3">{r.country ?? '—'}</td>
                        <td className="py-1.5 text-right">
                          <Button variant="ghost" size="sm" onClick={() => void measure(r.target.id)}>
                            <Crosshair size={11} />
                            Trace
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {/* active connections */}
      {showConnections && (
        <Card>
          <CardHeader
            title="Live connections"
            subtitle="Established TCP + UDP sockets with owning process (name via tasklist), latest measured RTT, ASN — metadata only, never payloads · auto-refresh 10s"
            actions={
              <Button variant="ghost" size="sm" onClick={() => void connectionsQuery.refetch()}>
                <RefreshCw size={12} />
                Refresh
              </Button>
            }
          />
          <CardBody>
            {connectionsQuery.isLoading && <p className="text-xs text-faint">Reading local connections…</p>}
            {connectionsQuery.data && !connectionsQuery.data.available && (
              <p className="text-xs text-faint">{connectionsQuery.data.reason ?? 'Not available on this platform.'}</p>
            )}
            {connectionsQuery.data?.available && (
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-surface-1 text-left text-[10px] uppercase tracking-wider text-faint">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Process</th>
                      <th className="py-1.5 pr-3 font-medium">Proto</th>
                      <th className="py-1.5 pr-3 font-medium">Remote</th>
                      <th className="py-1.5 pr-3 font-medium">RTT</th>
                      <th className="py-1.5 pr-3 font-medium">ASN</th>
                      <th className="py-1.5 pr-3 font-medium">Org</th>
                      <th className="py-1.5 pr-3 font-medium">Country</th>
                      <th className="py-1.5 pr-3 font-medium">State</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {connectionsQuery.data.rows.map((r, i) => (
                      <tr key={i} className="border-b border-line/40 last:border-0">
                        <td className="py-1.5 pr-3 font-mono text-muted">{hidden ? 'redacted' : r.process ?? `pid ${r.pid ?? '?'}`}</td>
                        <td className="py-1.5 pr-3 text-[10px] uppercase text-faint">{r.protocol}</td>
                        <td className="py-1.5 pr-3 font-mono">{r.remote ? (hidden ? maskIp(r.remote.split(':')[0]) : r.remote) : '—'}</td>
                        <td className={`py-1.5 pr-3 font-mono ${r.latencyMs != null ? (r.latencyMs <= 80 ? 'text-ok' : r.latencyMs <= 150 ? 'text-warn' : 'text-danger') : 'text-faint'}`}>
                          {r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : '—'}
                        </td>
                        <td className="py-1.5 pr-3 font-mono">{r.remoteAsn != null ? `AS${r.remoteAsn}` : '—'}</td>
                        <td className="max-w-40 truncate py-1.5 pr-3 text-faint">{r.remoteOrg ?? '—'}</td>
                        <td className="py-1.5 pr-3">{r.remoteCountry ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-faint">{r.state}</td>
                        <td className="py-1.5 text-right">
                          {r.remote && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                const ip = r.remote!.split(':')[0] ?? r.remote!;
                                setCustomHost(ip);
                                setCustomProtocol('tcp');
                                setCustomPort(String(r.remote!.split(':')[1] ?? '443'));
                                setShowConnections(false);
                                void measureCustom();
                              }}
                            >
                              <Crosshair size={11} />
                              Map it
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {connectionsQuery.data?.available && connectionsQuery.data.rows.length === 0 && (
              <p className="text-xs text-faint">No established TCP connections observed.</p>
            )}
          </CardBody>
        </Card>
      )}

      {selectedObs?.note && (
        <p className="text-[11px] text-faint">
          <span className="text-muted">Route note:</span> {selectedObs.note}
        </p>
      )}
    </div>
  );

  /* ----------------------------- NOC overlay ------------------------------- */

  if (noc) {
    return (
      <div className="fixed inset-0 z-50 bg-[#060a12]" onKeyDown={(e) => e.key === 'Escape' && setNoc(false)}>
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 border-b border-line/60 px-5 py-3 text-xs text-muted">
            <span className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.2em] text-accent">
              <MapIcon size={14} /> Live map · NOC
            </span>
            <span className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${measuring ? 'animate-pulse bg-accent' : 'bg-ok'}`} />
              {measuring ? 'measuring' : 'live'}
            </span>
            <span>VPN {local?.vpn.connected ? 'connected' : 'disconnected'}</span>
            {selectedObs && primaryLatency(selectedObs) != null && (
              <span>
                {selectedObs.target.name}: <span className="font-mono text-text">{fmtMs(primaryLatency(selectedObs))}</span>
              </span>
            )}
            {stats && (
              <span>
                loss <span className="font-mono text-text">{fmtPct(stats.loss)}</span>
              </span>
            )}
            <button className="ml-auto rounded-lg border border-line px-2.5 py-1 text-faint hover:text-text" onClick={() => setNoc(false)}>
              Exit (Esc)
            </button>
          </div>
          <div className="relative flex-1">
            <MapCanvas nodes={nodes} arcs={arcs} paths={paths} privacy={hidden} reducedMotion={reducedMotion} onSelect={(n) => n && n.id !== 'you' && setSelectedTargetId(n.id)} />
            {selectedObs?.insights.length ? (
              <div className="absolute bottom-4 left-4 max-w-md space-y-1 rounded-xl border border-line bg-bg/80 px-4 py-3 text-xs text-muted backdrop-blur">
                {selectedObs.insights.map((ins, i) => (
                  <p key={i}>{ins}</p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return content;
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wider text-faint">{label}</span>
      <span className={`truncate text-right text-muted ${mono ? 'font-mono' : ''}`}>{value ?? 'Unknown'}</span>
    </div>
  );
}