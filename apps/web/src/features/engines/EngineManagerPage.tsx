import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Cpu,
  Download,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { NodesNav } from '@/features/nodes/NodesChrome';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { engineVersionIsCurrent } from '@netpulse/shared';

import type { EngineReleaseCheck, ProxyEngineId, ProxyEngineStatus } from '@netpulse/shared';

/**
 * Aether is its own engine (separate binary, own install dir) — the fourth
 * card. GET /vpn/aether/engine returns this object directly; its install route
 * returns the outcome below (note: `status` is a plain string there).
 */
interface AetherEngineDto {
  installed: boolean;
  version: string | null;
  path: string | null;
  available: boolean;
  note: string;
}

interface AetherInstallOutcomeDto {
  ok: boolean;
  status: string;
  version: string | null;
  error: string | null;
  checksumVerified: boolean;
}

/** POST /nodes/engines/install — the manager's honest outcome, shown verbatim. */
interface InstallOutcomeDto {
  engine: string;
  status: 'installed' | 'updated' | 'already_current' | 'failed';
  version: string | null;
  path: string | null;
  checksumVerified: boolean;
  versionOutput: string | null;
  error: string | null;
  tookMs: number;
}

const REPO_LABEL: Record<ProxyEngineId, string> = {
  xray: 'XTLS/Xray-core',
  'sing-box': 'SagerNet/sing-box',
  v2ray: 'v2fly/v2ray-core',
  hysteria: 'apernet/hysteria',
};

function VersionLine({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="w-28 shrink-0 text-xs text-faint">{label}</span>
      {value ? (
        <span className="min-w-0 break-all font-mono text-xs" title={value}>
          {value}
        </span>
      ) : (
        <span className="text-xs text-faint">— not reported</span>
      )}
    </div>
  );
}

export default function EngineManagerPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const enginesQuery = useQuery({
    queryKey: ['engines'],
    queryFn: () => api.get<ProxyEngineStatus>('/nodes/engines'),
    staleTime: 20_000,
  });

  const releasesQuery = useQuery({
    queryKey: ['engines', 'releases'],
    queryFn: () => api.get<EngineReleaseCheck>('/nodes/engines/releases'),
    staleTime: 10 * 60_000,
  });

  const aetherQuery = useQuery({
    queryKey: ['aether', 'engine'],
    queryFn: () => api.get<AetherEngineDto>('/vpn/aether/engine'),
    staleTime: 20_000,
  });

  const install = useMutation({
    mutationFn: (engine: ProxyEngineId) =>
      api.post<InstallOutcomeDto>('/nodes/engines/install', { engine }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['engines'] });
      if (data.status === 'failed') {
        toast('error', `${data.engine} update failed`, data.error ?? 'the manager reported no detail');
      } else {
        toast(
          'ok',
          data.status === 'already_current' ? `${data.engine} already current` : `${data.engine} ${data.status}`,
          `${data.version ?? 'version unknown'}${data.checksumVerified ? ' — checksum verified' : ' — no published checksum for this asset'}`,
        );
      }
    },
    onError: (err) => toast('error', 'Engine update failed', err instanceof Error ? err.message : undefined),
  });

  const installAether = useMutation({
    mutationFn: () => api.post<AetherInstallOutcomeDto>('/vpn/aether/engine/install'),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['aether'] });
      if (!data.ok) toast('error', 'Aether update failed', data.error ?? 'no detail');
      else
        toast(
          'ok',
          `Aether ${data.status}`,
          `${data.version ?? 'version unknown'}${data.checksumVerified ? ' — checksum verified' : ' — UNVERIFIED checksum'}`,
        );
    },
    onError: (err) => toast('error', 'Aether update failed', err instanceof Error ? err.message : undefined),
  });

  const status = enginesQuery.data;
  const releases = releasesQuery.data;

  return (
    <DisclosureScope name="engines">
      <PageHeader
        title="Engine Manager"
        description="The local cores that run proxy tests and tunnels. Installs come only from each project's official release CDN, are verified against the published digest where one exists, and are validated by running the binary before the update is reported as done."
        actions={
          <Button
            loading={releasesQuery.isFetching}
            onClick={() => void releasesQuery.refetch()}
          >
            <RefreshCw size={14} /> Check for updates
          </Button>
        }
      />

      <NodesNav />
      <DisclosureToolbar className="mb-2" />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          Proxy tests use:{' '}
          <span className="font-medium text-text">
            {status?.effective ?? (enginesQuery.isSuccess ? 'no core installed' : '…')}
          </span>
        </span>
        <span className="text-faint">·</span>
        <span>
          preference: <span className="font-mono">{status?.preferred ?? '…'}</span>{' '}
          <span className="text-faint">(change it in Settings → VPN)</span>
        </span>
        {releases && (
          <>
            <span className="text-faint">·</span>
            <span>
              releases checked {timeAgo(releases.checkedAt)}
              {releases.cached ? ' (cached)' : ''}
            </span>
          </>
        )}
      </div>

      {enginesQuery.isLoading ? (
        <LoadingState label="Reading installed cores" />
      ) : enginesQuery.isError ? (
        <ErrorState error={enginesQuery.error} retry={() => void enginesQuery.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(status?.engines ?? []).map((engine) => {
            const release = releases?.releases.find((r) => r.id === engine.id) ?? null;
            const current = engineVersionIsCurrent(engine.version, release?.latestTag ?? null);
            return (
              <Card
                key={engine.id}
                fold={{
                  id: `engine-${engine.id}`,
                  // Open: this page exists to show each core's installed version,
                  // so a folded-by-default card would hide the answer. The folded
                  // header still carries the same facts when the user closes it.
                  summary: [
                    engine.available ? `installed${engine.version ? ` ${engine.version}` : ''}` : 'not installed',
                    release?.error ? 'latest unknown' : release?.latestTag ? `latest ${release.latestTag}` : 'latest not checked yet',
                  ].join(' · '),
                }}
              >
                <CardHeader
                  icon={<Cpu size={16} />}
                  title={engine.label}
                  subtitle={`${engine.id} · ${REPO_LABEL[engine.id]}`}
                  actions={
                    <Button
                      variant="secondary"
                      loading={install.isPending && install.variables === engine.id}
                      onClick={() => install.mutate(engine.id)}
                    >
                      <Download size={14} /> {engine.available ? 'Update' : 'Install'}
                    </Button>
                  }
                />
                <CardBody className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {engine.available ? (
                      <Badge tone="ok">Installed</Badge>
                    ) : (
                      <Badge tone="warn">Not installed</Badge>
                    )}
                    {release?.error ? (
                      <Badge tone="neutral">
                        <TriangleAlert size={11} /> latest unknown
                      </Badge>
                    ) : current === true ? (
                      <Badge tone="ok">Up to date</Badge>
                    ) : current === false ? (
                      <Badge tone="warn">Update available</Badge>
                    ) : (
                      <Badge tone="neutral">version not comparable</Badge>
                    )}
                  </div>

                  <VersionLine label="Installed" value={engine.version} />
                  <VersionLine label="Latest release" value={release?.latestTag ?? null} />
                  <VersionLine label="Path" value={engine.path} />

                  {release?.error && (
                    <p className="text-xs text-warn">
                      Latest version could not be read for {engine.id}: {release.error}
                    </p>
                  )}
                  {release?.url && (
                    <a
                      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      href={release.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={12} /> Release notes on GitHub
                    </a>
                  )}

                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {engine.protocols.map((p) => (
                      <span key={p} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                        {p}
                      </span>
                    ))}
                  </div>
                </CardBody>
              </Card>
            );
          })}

          {/* Aether ships as its own engine alongside the proxy cores. */}
          <Card
            fold={{
              id: 'engine-aether',
              summary: `${aetherQuery.data?.installed ? `installed${aetherQuery.data.version ? ` ${aetherQuery.data.version}` : ''}` : 'not installed'} · ${aetherQuery.data?.available ? 'an update is available' : 'no newer release known'}`,
            }}
          >
            <CardHeader
              icon={<ShieldCheck size={16} />}
              title="Aether"
              subtitle="CluvexStudio/Aether · censorship-circumvention tunnel (own installer)"
              actions={
                <Button
                  variant="secondary"
                  loading={installAether.isPending}
                  onClick={() => installAether.mutate()}
                >
                  <Download size={14} /> {aetherQuery.data?.installed ? 'Update' : 'Install'}
                </Button>
              }
            />
            <CardBody className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                {aetherQuery.data?.installed ? (
                  <Badge tone="ok">Installed</Badge>
                ) : (
                  <Badge tone="warn">Not installed</Badge>
                )}
                {aetherQuery.data?.available ? <Badge tone="accent">Available</Badge> : null}
              </div>
              <VersionLine label="Installed" value={aetherQuery.data?.version ?? null} />
              <VersionLine label="Path" value={aetherQuery.data?.path ?? null} />
              {aetherQuery.data?.note && <p className="text-xs text-muted">{aetherQuery.data.note}</p>}
            </CardBody>
          </Card>
        </div>
      )}

      <Card
        className="mt-4"
        fold={{
          id: 'update-method',
          defaultOpen: false,
          summary: 'official CDN only · digest verified when published · binary must answer its own version command',
        }}
      >
        <CardHeader icon={<Boxes size={16} />} title="What an update actually does" />
        <CardBody className="space-y-1.5 text-xs text-muted">
          <p>
            The binary is downloaded from the project's official release assets (hosts are allowlisted, the
            download is size- and time-capped and never piped into a shell).
          </p>
          <p>
            Where the project publishes a digest (Xray/v2ray <span className="font-mono">.dgst</span>, Aether{' '}
            <span className="font-mono">.sha256</span>) it is verified before anything is written; a mismatch
            discards the download.
          </p>
          <p>
            The extracted binary must identify itself via its own <span className="font-mono">version</span>{' '}
            command before the install is reported as complete — a core that cannot answer is not installed.
          </p>
          <p>
            Nothing is installed silently: failures are reported verbatim, and the version above is read from
            the installed binary, not from the download.
          </p>
        </CardBody>
      </Card>
    </DisclosureScope>
  );
}
