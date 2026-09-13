import type {
  ConnectivityMeasurement,
  IranClassification,
  IranConfidence,
  IranDnsProbe,
  IranHttpProbe,
  IranIncident,
  IranRouteProbe,
  IranScoreBreakdown,
  IranTcpProbe,
  IranTlsProbe,
} from '@netpulse/shared';

/* ------------------------------ classification --------------------------- */

export interface ClassifyInput {
  dns: IranDnsProbe | null;
  tcp: IranTcpProbe | null;
  tls: IranTlsProbe | null;
  http: IranHttpProbe | null;
  route: IranRouteProbe | null;
  /** tunnel active for this connection */ vpnConnected: boolean;
  /** VPN profile that is NOT connected — only the endpoint was probed */ endpointOnly: boolean;
  repeats: number;
  /** fraction of repeat passes that completed all stages */ successRate: number;
  medianLatencyMs: number | null;
}

/**
 * Evidence-based per-cell classification.
 *
 * Filtering is an *inference*, never an assertion: a single failed request is
 * never enough, and every assessment carries a confidence and evidence list.
 */
export function classifyCell(input: ClassifyInput): IranClassification {
  const { dns, tcp, tls, http, endpointOnly, vpnConnected, repeats, successRate, medianLatencyMs } = input;
  const evidence: string[] = [];
  void vpnConnected;

  const confidenceFor = (base: IranConfidence): IranConfidence => {
    if (repeats >= 3) return base === 'Unknown' ? 'Medium' : base;
    if (repeats >= 2) return base === 'High' ? 'Medium' : base;
    return base;
  };

  // VPN profile not connected — only the endpoint itself was probed.
  if (endpointOnly) {
    if (tcp?.ok) {
      evidence.push(`VPN endpoint answers TCP/${tcp.port} in ${tcp.latencyMs} ms`);
      evidence.push('Tunnel is not connected — full path not measured for this profile');
      return {
        state: 'Reachable',
        assessment: 'Insufficient Evidence',
        confidence: confidenceFor('Medium'),
        evidence,
      };
    }
    evidence.push(tcp?.error ? `VPN endpoint TCP/${tcp.port} failed: ${tcp.error}` : 'VPN endpoint did not answer');
    evidence.push('Tunnel is not connected — endpoint reachability only');
    return {
      state: tcp?.error?.toLowerCase().includes('reset') ? 'Connection Reset' : 'Endpoint Unavailable',
      assessment: tcp?.error?.toLowerCase().includes('timeout') ? 'Network Failure' : 'Possible Filtering',
      confidence: confidenceFor('Low'),
      evidence,
    };
  }

  // 1. DNS stage
  if (!dns?.ok) {
    const reason = dns?.nxdomain
      ? `DNS returned NXDOMAIN for the hostname`
      : dns?.error
        ? `DNS query failed: ${dns.error}`
        : 'DNS did not respond';
    evidence.push(reason);
    if (dns?.resolver) evidence.push(`Resolver: ${dns.resolver}`);
    const nxdomain = dns?.nxdomain === true;
    return {
      state: 'DNS Failure',
      assessment: nxdomain ? 'Service Failure' : repeats >= 2 ? 'Possible Filtering' : 'Network Failure',
      confidence: confidenceFor(nxdomain ? 'High' : 'Low'),
      evidence,
    };
  }
  evidence.push(`DNS resolved (${dns.a?.length ?? 0} A, ${dns.aaaa?.length ?? 0} AAAA records, ${dns.latencyMs ?? '?'} ms)`);
  if (dns.cname && dns.cname.length > 0) evidence.push(`CNAME chain: ${dns.cname.join(' → ')}`);
  if (dns.a && dns.a.length > 0 && (!dns.aaaa || dns.aaaa.length === 0)) evidence.push('IPv4 only — no AAAA records returned');

  // 2. TCP stage
  if (!tcp?.ok) {
    const err = (tcp?.error ?? '').toLowerCase();
    if (err.includes('timeout')) {
      evidence.push(`TCP/${tcp?.port ?? 443} timed out after the probe window`);
      return { state: 'Timeout', assessment: 'Network Failure', confidence: confidenceFor('Low'), evidence };
    }
    if (err.includes('reset')) {
      evidence.push(`TCP/${tcp?.port ?? 443} connection was reset`);
      return { state: 'Connection Reset', assessment: 'Possible Filtering', confidence: confidenceFor('Low'), evidence };
    }
    if (err.includes('refused')) {
      evidence.push(`TCP/${tcp?.port ?? 443} refused the connection`);
      return { state: 'Endpoint Unavailable', assessment: 'Service Failure', confidence: confidenceFor('Medium'), evidence };
    }
    if (err.includes('unreachable') || err.includes('no route')) {
      evidence.push(`TCP/${tcp?.port ?? 443}: ${tcp?.error}`);
      return { state: 'Routing Failure', assessment: 'Network Failure', confidence: confidenceFor('Low'), evidence };
    }
    evidence.push(`TCP/${tcp?.port ?? 443} failed: ${tcp?.error ?? 'unknown error'}`);
    return { state: 'TCP Blocked', assessment: 'Insufficient Evidence', confidence: confidenceFor('Low'), evidence };
  }
  evidence.push(`TCP/${tcp.port} connects in ${tcp.latencyMs} ms (IPv${tcp.family ?? '?'})`);

  // 3. TLS stage
  if (!tls?.ok) {
    const err = (tls?.error ?? '').toLowerCase();
    if (err.includes('timeout')) {
      evidence.push(`TLS handshake to :${tcp.port} timed out after TCP success`);
      return { state: 'TLS Failure', assessment: 'Possible Filtering', confidence: confidenceFor('Medium'), evidence };
    }
    if (err.includes('reset') || err.includes('econnreset') || err.includes('hang up') || err.includes('aborted') || err.includes('closed')) {
      evidence.push(`TLS handshake to :${tcp.port} was interrupted after TCP connected: ${tls?.error}`);
      evidence.push('TCP succeeds but TLS is interrupted — a common interference signature');
      return { state: 'TLS Failure', assessment: 'Possible Filtering', confidence: confidenceFor('Medium'), evidence };
    }
    evidence.push(`TLS handshake to :${tcp.port} failed: ${tls?.error ?? 'unknown error'}`);
    return { state: 'TLS Failure', assessment: 'Insufficient Evidence', confidence: confidenceFor('Low'), evidence };
  }
  evidence.push(`TLS ${tls.tlsVersion ?? 'handshake'} completes in ${tls.latencyMs} ms`);
  if (tls.authorized === false) {
    evidence.push('Certificate validation failed — do not weaken validation to make a site appear reachable');
  }

  // 4. HTTPS stage
  if (!http?.ok) {
    const err = (http?.error ?? '').toLowerCase();
    if (err.includes('timeout')) {
      evidence.push(`HTTPS request timed out after TLS succeeded`);
      return { state: 'Timeout', assessment: 'Possible Filtering', confidence: confidenceFor('Medium'), evidence };
    }
    if (err.includes('reset')) {
      evidence.push(`HTTPS response was reset after TLS succeeded`);
      return { state: 'HTTP Blocked', assessment: 'Possible Filtering', confidence: confidenceFor('Medium'), evidence };
    }
    evidence.push(`HTTPS request failed after TLS: ${http?.error ?? 'unknown error'}`);
    return { state: 'HTTP Error', assessment: 'Insufficient Evidence', confidence: confidenceFor('Low'), evidence };
  }
  if (http.status != null && http.status >= 400) {
    evidence.push(`Server responded with HTTP ${http.status} — reachable at network level, service-level error`);
    return { state: 'HTTP Error', assessment: 'Service Failure', confidence: confidenceFor('High'), evidence };
  }
  evidence.push(`HTTPS ${http.status} in ${http.latencyMs} ms (${http.contentType ?? 'unknown content type'})`);
  if (http.redirectChain.length > 1) {
    evidence.push(`Redirect chain: ${http.redirectChain.join(' → ')}`);
    if (http.redirectChain.some((u) => /^(http|https):\/\/([0-9.]+|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u))) {
      evidence.push('Redirect lands on a non-standard host — network-generated response suspected');
    }
  }

  const allOk = successRate >= 1 - 1e-9;
  if (allOk) {
    return {
      state: 'Reachable',
      assessment: 'Likely Reachable',
      confidence: confidenceFor(repeats >= 2 ? 'High' : 'Medium'),
      evidence,
    };
  }

  evidence.push(`Intermittent: ${Math.round((1 - successRate) * 100)}% of repeat passes failed`);
  return {
    state: 'Partially Reachable',
    assessment: medianLatencyMs != null ? 'Possible Filtering' : 'Insufficient Evidence',
    confidence: confidenceFor('Medium'),
    evidence,
  };
}

/* ------------------------------ differential ----------------------------- */

/**
 * Post-process all cells of one target. Compares direct vs VPN outcomes so we
 * can honestly report "reachable only via VPN" vs "reachable only direct"
 * instead of a bare failure, and detect DNS manipulation (system resolver
 * differs from an alternative resolver).
 */
export function applyDifferential(cells: { connectionId: string; connectionName: string; measurement: ConnectivityMeasurement }[]): ConnectivityMeasurement[] {
  const direct = cells.find((c) => c.connectionId === 'direct')?.measurement;
  const vpnCells = cells.filter((c) => c.connectionId !== 'direct');
  const anyVpnReached = vpnCells.some((c) => c.measurement.classification.assessment === 'Likely Reachable' || c.measurement.classification.state === 'Reachable');
  const directReached = direct != null && (direct.classification.assessment === 'Likely Reachable' || direct.classification.state === 'Reachable');

  return cells.map(({ measurement }) => {
    const cls = measurement.classification;
    if (measurement.connectionId === 'direct') {
      // DNS manipulation: direct DNS failed but an alternative resolver answered
      if (!measurement.dns?.ok && measurement.dns && !measurement.dns.nxdomain) {
        const evidence = [...cls.evidence];
        evidence.push('Direct DNS failed; alternative-resolver comparison available in the DNS view');
        return { ...measurement, classification: { ...cls, evidence } };
      }
      if (!directReached && anyVpnReached && !measurement.dns?.ok) {
        return {
          ...measurement,
          classification: {
            state: 'VPN Only',
            assessment: 'Possible Filtering',
            confidence: 'Medium',
            evidence: [...cls.evidence, 'Direct path failed while a VPN path reached the target — DNS-level interference suspected'],
          },
        };
      }
      return measurement;
    }
    // VPN cells
    if (measurement.dns && !measurement.dns.ok && !measurement.dns.nxdomain && direct?.dns?.ok) {
      return {
        ...measurement,
        classification: {
          state: 'DNS Failure',
          assessment: 'Network Failure',
          confidence: 'Medium',
          evidence: [...cls.evidence, 'DNS failed through this path while the direct path resolved the hostname'],
        },
      };
    }
    if (!anyVpnReached && directReached && vpnCells.length > 0) {
      return {
        ...measurement,
        classification: {
          state: 'Direct Only',
          assessment: 'Insufficient Evidence',
          confidence: 'Low',
          evidence: [...cls.evidence, 'Direct path reaches the target; the VPN path does not — VPN route/exit issue, not direct filtering'],
        },
      };
    }
    if (anyVpnReached && !directReached) {
      return {
        ...measurement,
        classification: {
          state: 'VPN Only',
          assessment: 'Likely Filtered',
          confidence: measurement.classification.confidence === 'Unknown' ? 'Medium' : measurement.classification.confidence,
          evidence: [...cls.evidence, 'Direct path failed but a VPN path reached the target — differential evidence of filtering'],
        },
      };
    }
    return measurement;
  });
}

/* --------------------------------- scoring ------------------------------- */

export function scoreCell(m: ConnectivityMeasurement): IranScoreBreakdown | null {
  const { dns, tcp, tls, http, route, classification } = m;
  const noData = dns == null && tcp == null && tls == null && http == null;
  if (noData) return null;

  const reachability =
    http?.ok && (http.status ?? 0) < 400 ? 100 :
    tls?.ok ? 80 :
    tcp?.ok ? 50 :
    dns?.ok ? 20 : 0;

  const latencyMs = http?.latencyMs ?? tls?.latencyMs ?? tcp?.latencyMs ?? null;
  const latency =
    latencyMs == null ? 0 :
    latencyMs <= 30 ? 100 :
    latencyMs <= 60 ? 90 :
    latencyMs <= 100 ? 75 :
    latencyMs <= 150 ? 60 :
    latencyMs <= 250 ? 40 : 20;

  const stability = m.samples > 1 ? Math.round((m.samples > 0 ? 1 : 0) * 100) : 100;
  const tlsScore = tls?.ok ? (tls.authorized === false ? 60 : 100) : 0;
  const routeScore = route?.ok ? (route.asnPath.length > 0 ? 100 : 60) : route ? 40 : 0;

  const total = Math.round(
    reachability * 0.4 + latency * 0.2 + stability * 0.15 + tlsScore * 0.15 + routeScore * 0.1,
  );
  void classification;
  return { reachability, latency, stability, tls: tlsScore, route: routeScore, total };
}

/* ------------------------------- incidents ------------------------------- */

const STABLE = new Set(['Reachable', 'Partially Reachable', 'Likely Reachable']);

export function diffIncidents(prev: ConnectivityMeasurement[], cur: ConnectivityMeasurement[]): IranIncident[] {
  const incidents: IranIncident[] = [];
  const byKey = (list: ConnectivityMeasurement[]) => new Map(list.map((m) => [`${m.targetId}:${m.connectionId}`, m]));

  const prevMap = byKey(prev);
  const curMap = byKey(cur);
  for (const [key, curM] of curMap) {
    const prevM = prevMap.get(key);
    if (!prevM) continue;
    const parts = key.split(':');
    const targetId = parts[0] ?? 'unknown';
    const targetName = curM.targetId;
    void parts;
    const wasStable = STABLE.has(prevM.classification.state);
    const isStable = STABLE.has(curM.classification.state);
    const id = `${curM.sessionId}:${key}`;

    if (wasStable && !isStable) {
      incidents.push({
        id: `down:${id}`,
        targetId,
        targetName,
        type: 'became-unreachable',
        severity: 'critical',
        message: `${targetName} became unreachable (${curM.classification.state}) on ${curM.connectionName}.`,
        observedAt: curM.startedAt,
      });
    } else if (!wasStable && isStable) {
      incidents.push({
        id: `up:${id}`,
        targetId,
        targetName,
        type: 'recovered',
        severity: 'info',
        message: `${targetName} recovered on ${curM.connectionName}.`,
        observedAt: curM.startedAt,
      });
    }

    const prevLat = prevM.http?.latencyMs ?? prevM.tls?.latencyMs ?? prevM.tcp?.latencyMs;
    const curLat = curM.http?.latencyMs ?? curM.tls?.latencyMs ?? curM.tcp?.latencyMs;
    if (prevLat != null && curLat != null && curLat > prevLat * 1.5 && curLat - prevLat >= 20) {
      incidents.push({
        id: `lat:${id}`,
        targetId,
        targetName,
        type: 'latency-increased',
        severity: 'warn',
        message: `${targetName} latency on ${curM.connectionName} increased from ${Math.round(prevLat)} ms to ${Math.round(curLat)} ms.`,
        observedAt: curM.startedAt,
      });
    }

    const prevA = prevM.dns?.a?.slice().sort() ?? [];
    const curA = curM.dns?.a?.slice().sort() ?? [];
    if (prevA.length > 0 && curA.length > 0 && JSON.stringify(prevA) !== JSON.stringify(curA)) {
      incidents.push({
        id: `dns:${id}`,
        targetId,
        targetName,
        type: 'dns-changed',
        severity: 'info',
        message: `${targetName} DNS answers changed (${prevA.join(', ')} → ${curA.join(', ')}).`,
        observedAt: curM.startedAt,
      });
    }

    const prevPath = prevM.route?.asnPath.map((h) => h.asn).filter((x): x is number => x != null).join(',');
    const curPath = curM.route?.asnPath.map((h) => h.asn).filter((x): x is number => x != null).join(',');
    if (prevPath && curPath && prevPath !== curPath) {
      incidents.push({
        id: `route:${id}`,
        targetId,
        targetName,
        type: 'route-changed',
        severity: 'info',
        message: `${targetName} ASN path on ${curM.connectionName} changed (${prevPath} → ${curPath}).`,
        observedAt: curM.startedAt,
      });
    }
  }
  return incidents;
}

/* ------------------------------ DNS differential ------------------------- */

export interface DnsDifferential {
  system: IranDnsProbe | null;
  alt: IranDnsProbe | null;
  /** system and alternative resolver disagree on the A set */
  differs: boolean;
  note: string;
}

export function dnsDifferential(system: IranDnsProbe | null, alt: IranDnsProbe | null): DnsDifferential {
  if (!system || !alt) return { system, alt, differs: false, note: 'No alternative-resolver comparison available for this connection.' };
  const a = system.a?.slice().sort() ?? [];
  const b = alt.a?.slice().sort() ?? [];
  const differs = a.length > 0 && b.length > 0 && JSON.stringify(a) !== JSON.stringify(b);
  if (differs) {
    return {
      system,
      alt,
      differs: true,
      note: `DNS responses differ between resolvers (${system.resolver ?? 'system'} → ${a.join(', ')}; ${alt.resolver ?? 'alt'} → ${b.join(', ')}). DNS manipulation is one possible explanation; do not treat it as proven.`,
    };
  }
  return { system, alt, differs: false, note: 'DNS responses agree across resolvers.' };
}

/* ------------------------------- summary --------------------------------- */

export function buildSummary(
  measurements: ConnectivityMeasurement[],
  connections: { id: string; name: string }[],
): {
  healthScore: number;
  reachable: number;
  total: number;
  possibleFiltering: number;
  networkFailures: number;
  unavailableServices: number;
  bestConnectionId: string | null;
  bestConnectionName: string | null;
} {
  const byTarget = new Map<string, ConnectivityMeasurement[]>();
  for (const m of measurements) {
    const list = byTarget.get(m.targetId) ?? [];
    list.push(m);
    byTarget.set(m.targetId, list);
  }
  let reachable = 0;
  let possibleFiltering = 0;
  let networkFailures = 0;
  let unavailableServices = 0;
  for (const [targetId, cells] of byTarget) {
    const anyStable = cells.some((c) => STABLE.has(c.classification.state));
    if (anyStable) reachable++;
    if (cells.some((c) => c.classification.assessment === 'Possible Filtering' || c.classification.assessment === 'Likely Filtered')) possibleFiltering++;
    if (cells.some((c) => c.classification.assessment === 'Network Failure' || c.classification.state === 'Timeout' || c.classification.state === 'Routing Failure')) networkFailures++;
    if (cells.some((c) => c.classification.state === 'Endpoint Unavailable')) unavailableServices++;
    void targetId;
  }
  const total = byTarget.size;
  const healthScore = total === 0 ? 0 : Math.round((reachable / total) * 100);

  // best connection: highest average score across measured targets
  let bestConnectionId: string | null = null;
  let bestConnectionName: string | null = null;
  let bestAvg = -1;
  for (const conn of connections) {
    const connMs = measurements.filter((m) => m.connectionId === conn.id && m.score != null);
    if (connMs.length === 0) continue;
    const avg = connMs.reduce((s, m) => s + (m.score?.total ?? 0), 0) / connMs.length;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestConnectionId = conn.id;
      bestConnectionName = conn.name;
    }
  }

  return { healthScore, reachable, total, possibleFiltering, networkFailures, unavailableServices, bestConnectionId, bestConnectionName };
}