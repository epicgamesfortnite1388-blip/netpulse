import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, ShieldAlert, Wifi } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { Section } from '@/components/ui/Surface';

import type { WhitednsConfig, WhitednsTunnelTestRequest, WhitednsTunnelTestResult } from '@netpulse/shared';

/**
 * WhiteDNS Soar DNS tunnel surface.
 *
 * Verifies the server-side DNS data plane and, when the `soar-check`
 * diagnostic is available on the host, proves an authenticated tunnel carries
 * real data. Never stores or reveals the panel access path or credentials.
 */
export function WhitednsSurface() {
  const toast = useToast();
  const [running, setRunning] = useState(false);

  const config = useQuery({
    queryKey: ['whitedns', 'config'],
    queryFn: () => api.get<WhitednsConfig>('/whitedns/config'),
    refetchInterval: 30_000,
  });

  const test = useMutation({
    mutationFn: (req: WhitednsTunnelTestRequest) =>
      api.post<WhitednsTunnelTestResult>('/whitedns/tunnel-test', req),
    onMutate: () => setRunning(true),
    onSuccess: () => setRunning(false),
    onError: () => setRunning(false),
  });

  const runTest = () => {
    if (!config.data?.zone || !config.data?.server) {
      toast('error', 'Not configured', 'The WhiteDNS zone and server are not configured on this node.');
      return;
    }
    test.mutate({
      zone: config.data.zone,
      server: config.data.server,
      url: 'https://example.com/',
      timeoutMs: 60_000,
    });
  };

  const result = test.isSuccess ? test.data : null;

  return (
    <Section title="WhiteDNS Soar DNS tunnel" icon={<Wifi size={15} />} subtitle="Verifies the WhiteDNS Soar DNS data plane on this node.">
      <div className="stagger space-y-4">
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-micro font-semibold uppercase tracking-[0.16em] text-faint">Server</span>
            {config.isError ? (
              <span className="text-sm text-danger">configuration could not be read</span>
            ) : config.data?.zone && config.data?.server ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text">{config.data.server}</span>
                <span className="ml-2 text-xs text-muted">zone {config.data.zone}</span>
                {config.data.hasPubkey ? (
                  <Badge tone="ok">
                    <Check size={10} /> profile key present
                  </Badge>
                ) : (
                  <Badge tone="warn">
                    <ShieldAlert size={10} /> no profile key
                  </Badge>
                )}
              </div>
            ) : (
              <span className="text-sm text-muted">not configured</span>
            )}
          </div>
          <p className="text-xs text-muted">
            The test queries the tunnel zone authoritatively over UDP/53 and
            TCP/53, then fetches an HTTPS URL through the authenticated tunnel
            when a profile key and the soar-check diagnostic are present.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={runTest}
            disabled={running || !config.data?.zone || !config.data?.server}
            loading={running}
            variant="primary"
          >
            <ArrowRight size={13} />
            {running ? 'Testing...' : 'Run data-plane test'}
          </Button>
          {test.isError && (
            <Badge tone="danger">{test.error instanceof Error ? test.error.message : 'test failed'}</Badge>
          )}
        </div>

        {result && (
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-micro font-semibold uppercase tracking-[0.16em] text-faint">Result</span>
              <span className={`ml-auto text-sm font-medium ${result.ok ? 'text-ok' : 'text-danger'}`}>
                {result.ok ? 'All stages passed' : `Stage ${result.stage} failed`}
              </span>
              <span className="text-xs text-muted">{result.tookMs} ms</span>
            </div>
            <div className="space-y-1.5">
              {result.stages.map((s) => (
                <div key={s.name} className="flex items-center gap-3 text-sm">
                  <span className={`h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-micro ${s.ok ? 'bg-ok text-ok-strong' : 'bg-danger text-danger-strong'}`}>
                    {s.ok ? 'OK' : 'FAIL'}
                  </span>
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className={`text-micro ${s.ok ? 'text-text' : 'text-danger'}`}>{s.detail}</span>
                  {s.ms != null && <span className="text-micro text-muted">{s.ms} ms</span>}
                </div>
              ))}
            </div>
            {!result.ok && result.error && <p className="mt-2 text-xs text-danger">{result.error}</p>}
            {result.ok && (
              <p className="mt-2 text-xs text-ok">
                The tunnel authenticated and carried HTTPS data. The WhiteDNS
                client can connect using this node's zone/profile.
              </p>
            )}
          </div>
        )}

        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-micro font-semibold uppercase tracking-[0.16em] text-faint">Connect a client</span>
          </div>
          <p className="text-xs text-muted mb-3">
            Import the account's soar:// direct profile (or subscription URL) from
            the WhiteDNS management panel into the WhiteDNS app, then connect.
            The app carries the tunnel; this surface only verifies the server side.
          </p>
          <p className="text-xs text-faint">
            Never paste the panel access path, administrator password, or session
            cookie here. The randomized management path is reachable only over the
            SSH tunnel and must not be recorded in this app.
          </p>
        </div>
      </div>
    </Section>
  );
}
