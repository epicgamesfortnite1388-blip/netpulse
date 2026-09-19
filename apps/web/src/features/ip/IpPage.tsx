import { useCallback, useRef, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Globe, Info, MapPin, Server, ShieldAlert, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingState } from '@/components/ui/States';
import { api } from '@/lib/api';

import type { IpFamily } from '@shared/models/common';
import type { IpInfo } from '@shared/models/ip';

function useIp(family: IpFamily) {
  return useQuery({
    queryKey: ['ip', family],
    queryFn: () => api.get<{ info: IpInfo }>(`/ip?family=${family}`),
    staleTime: 60_000,
    retry: 0,
  });
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="metric-num text-[13px] text-text">{value ?? <span className="text-faint">—</span>}</span>
    </div>
  );
}

function FamilyCard({ family, query }: { family: IpFamily; query: ReturnType<typeof useIp> }) {
  const info = query.data?.info;
  return (
    <Card>
      <CardHeader
        title={`IPv${family}`}
        icon={<Globe size={15} />}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()} loading={query.isFetching}>
            Refresh
          </Button>
        }
      />
      <CardBody>
        {query.isError ? (
          <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
            {query.error instanceof Error ? query.error.message : 'Lookup failed'}
            {family === 6 && (
              <p className="mt-1 text-xs text-faint">
                Your network may not provide IPv6 connectivity — this is common and not an error of the app.
              </p>
            )}
          </div>
        ) : query.isLoading || !info ? (
          <LoadingState label={`Resolving IPv${family}`} />
        ) : (
          <div className="space-y-0.5">
            <Row label="Address" value={info.ip} />
            <Row label="ISP" value={info.isp} />
            <Row label="Organization" value={info.org} />
            <Row
              label="ASN"
              value={info.asn.asn != null ? `AS${info.asn.asn}${info.asn.org ? ` · ${info.asn.org}` : ''}` : null}
            />
            <Row label="Country" value={info.countryCode ? `${info.country ?? ''} (${info.countryCode})` : info.country} />
            <Row label="Region" value={info.region} />
            <Row label="City" value={info.city} />
            <Row label="Timezone" value={info.timezone} />
            <Row
              label="Coordinates"
              value={
                info.latitude != null && info.longitude != null
                  ? `${info.latitude.toFixed(3)}, ${info.longitude.toFixed(3)}`
                  : null
              }
            />
            <Row label="Reverse DNS" value={info.reverseDns} />
            <Row label="CF edge" value={info.edgeLocation} />
            <Row label="Sources" value={info.sources.join(' + ')} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

interface WebrtcResult {
  testId: string;
  candidateCount: number;
  publicIps: string[];
  leaked: string[];
  leakedCount: number;
  status: 'no-leak' | 'leak';
  note: string;
}

/**
 * Browser-side WebRTC leak check. ICE candidates are collected from a real
 * RTCPeerConnection (STUN only — no media) and compared server-side against
 * the public addresses measured by the IP intelligence service. This is the
 * only way to observe WebRTC behavior: it is a browser-level phenomenon the
 * backend cannot see.
 */
function WebrtcLeakCard() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WebrtcResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const runCheck = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);

    const candidates: string[] = [];
    const seen = new Set<string>();
    const collect = (ip: string | null | undefined) => {
      if (!ip || ip.length === 0) return;
      if (ip.toLowerCase().endsWith('.local')) return; // mDNS mask — not evidence
      if (seen.has(ip)) return;
      seen.add(ip);
      candidates.push(ip);
    };

    try {
      if (typeof RTCPeerConnection === 'undefined') {
        throw new Error('This browser does not support RTCPeerConnection, so a WebRTC leak check is not possible here.');
      }
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }],
      });
      pcRef.current = pc;

      pc.onicecandidate = (ev) => {
        const ip = ev.candidate?.address;
        if (ip) collect(ip);
        else collect(ev.candidate?.candidate?.split(' ')[4]);
      };

      // createOffer with data channel forces candidate gathering without media
      const dc = pc.createDataChannel('probe');
      void dc;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // wait for gathering to settle or timeout
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          pc.onicecandidate = null;
          resolve();
        }, 4_000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(t);
            pc.onicecandidate = null;
            resolve();
          }
        };
      });

      pc.close();
      pcRef.current = null;

      const res = await api.post<{ result: WebrtcResult }>('/webrtc-report', { candidates });
      setResult(res.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'WebRTC leak check failed');
      pcRef.current?.close();
      pcRef.current = null;
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <Card>
      <CardHeader
        title="WebRTC leak check"
        icon={result?.status === 'leak' ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void runCheck()} loading={running} disabled={running}>
            {result == null && !running ? 'Run check' : 'Run again'}
          </Button>
        }
      />
      <CardBody>
        {running ? (
          <LoadingState label="Gathering ICE candidates (STUN)…" />
        ) : error ? (
          <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-muted">{error}</div>
        ) : result == null ? (
          <div className="flex items-start gap-2.5 text-sm text-muted">
            <Info size={15} className="mt-0.5 shrink-0 text-accent" />
            <p className="leading-relaxed">
              WebRTC can leak your local IP through STUN without any media. The browser's ICE candidates are
              collected and compared against the public addresses measured by the IP intelligence service.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div
              className={`flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm ${
                result.status === 'leak' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-ok/40 bg-ok/10 text-ok'
              }`}
            >
              {result.status === 'leak' ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
              <span className="font-medium">
                {result.status === 'leak' ? 'Potential WebRTC exposure detected' : 'No WebRTC mismatch observed'}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-faint">{result.note}</p>
            <div className="grid grid-cols-2 gap-3">
              <Badge tone="neutral">{result.candidateCount} candidate(s)</Badge>
              {result.leakedCount > 0 && <Badge tone="danger">{result.leakedCount} not matching public IPs</Badge>}
            </div>
            {result.leaked.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {result.leaked.map((ip) => (
                  <code key={ip} className="rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text">
                    {ip}
                  </code>
                ))}
              </div>
            )}
            {result.publicIps.length > 0 && (
              <div className="text-xs text-faint">
                Public IPs compared against: {result.publicIps.join(', ')}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export default function IpPage() {
  const v4 = useIp(4);
  const v6 = useIp(6);

  return (
    <DisclosureScope name="ip">
      <PageHeader
        title="IP intelligence"
        description="Your public addresses, network operator and geolocation — measured, with sources shown."
      />
      <DisclosureToolbar className="-mt-3 mb-2" />

      <div className="grid gap-5 lg:grid-cols-2">
        <FamilyCard family={4} query={v4} />
        <FamilyCard family={6} query={v6} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <WebrtcLeakCard />
        <Card
          fold={{ id: 'ip-reputation', defaultOpen: false, summary: 'unknown — no reputation provider configured yet' }}
        >
          <CardHeader title="IP reputation" icon={<Server size={15} />} />
          <CardBody>
            <div className="flex items-start gap-2.5 text-sm text-muted">
              <Info size={15} className="mt-0.5 shrink-0 text-accent" />
              <p className="leading-relaxed">
                No reputation providers are configured yet, so your IP's reputation is
                <strong className="text-text"> unknown</strong> — not "clean", just untested. Reputation
                providers (abuse databases, blocklists) can be registered in the provider architecture without
                touching the rest of the app.
              </p>
            </div>
          </CardBody>
        </Card>

        <Card fold={{ id: 'location-note', defaultOpen: false, summary: 'geolocation is ISP registry data, city-level at best' }}>
          <CardHeader title="Location privacy note" icon={<MapPin size={15} />} />
          <CardBody>
            <p className="text-sm leading-relaxed text-muted">
              Geolocation is derived from your public IP's registry data (city-level at best). It reflects
              where your ISP announces your address, not your physical location.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone="neutral">accuracy: city-level</Badge>
              <Badge tone="neutral">source: registry + geo DB</Badge>
            </div>
          </CardBody>
        </Card>
      </div>
    </DisclosureScope>
  );
}
