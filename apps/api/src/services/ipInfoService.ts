import dns from 'node:dns/promises';

import type { IpFamily, IpInfo } from '@netpulse/shared';

import { AppError } from '../util/appError';
import { fetchCloudflareTrace } from '../providers/ipinfo/cloudflareTrace';
import { fetchIpify } from '../providers/ipinfo/ipify';
import { fetchIpWhoIs } from '../providers/ipinfo/ipwhoIs';
import type { ProviderRegistry } from '../providers/registry';

import type { ReputationProvider } from '../providers/reputation/types';

interface CacheEntry {
  info: IpInfo;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;

export interface IpInfoDeps {
  reputationProviders: ProviderRegistry<ReputationProvider>;
}

/**
 * Combines Cloudflare trace (IP discovery, edge location) with ipwho.is
 * (geo/ASN) and reverse DNS. Results are cached in-memory per family.
 * Reputation is only ever filled by registered reputation providers —
 * an empty registry yields an honest empty array.
 */
export class IpInfoService {
  private cache = new Map<IpFamily, CacheEntry>();
  private readonly reputationProviders: ProviderRegistry<ReputationProvider>;

  constructor(deps: IpInfoDeps) {
    this.reputationProviders = deps.reputationProviders;
  }

  async lookup(family: IpFamily, opts: { force?: boolean } = {}): Promise<IpInfo> {
    const cached = this.cache.get(family);
    if (!opts.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.info;
    }

    // Family-forced discovery: Cloudflare trace over a literal IP, falling
    // back to ipify (v4/v6 hosts) when raw-IP HTTPS is blocked on this
    // network. The ipify source is only trusted when it returns an address
    // of the requested family.
    const [trace, ipify] = await Promise.all([
      fetchCloudflareTrace(family),
      fetchIpify(family),
    ]);

    const discoveredIp = trace?.ip ?? (ipify?.ip ?? null);
    if (!discoveredIp) {
      throw new AppError(
        502,
        'ip_lookup_failed',
        'No IP intelligence source could be reached',
        'Check your internet connection and try again.',
      );
    }

    const sources = [trace && 'cloudflare-trace', ipify && 'ipify'].filter(Boolean) as string[];

    const detail = await fetchIpWhoIs(discoveredIp);
    let reverseDns: string | null = null;
    try {
      reverseDns = (await dns.reverse(discoveredIp))[0] ?? null;
    } catch {
      reverseDns = null;
    }

    const reputation = [];
    for (const provider of this.reputationProviders.all()) {
      try {
        const verdict = await provider.check(discoveredIp);
        if (verdict) reputation.push(verdict);
      } catch {
        // a failing reputation provider must not break the lookup
      }
    }

    const info: IpInfo = {
      ip: discoveredIp,
      family,
      country: detail?.country ?? trace?.loc ?? null,
      countryCode: detail?.countryCode ?? trace?.loc ?? null,
      region: detail?.region ?? null,
      city: detail?.city ?? null,
      latitude: detail?.latitude ?? null,
      longitude: detail?.longitude ?? null,
      timezone: detail?.timezone ?? null,
      isp: detail?.isp ?? null,
      org: detail?.org ?? null,
      asn: { asn: detail?.asn ?? null, org: detail?.asnOrg ?? null },
      reverseDns,
      edgeLocation: trace?.colo ?? null,
      reputation,
      sources: [...sources, detail && 'ipwho.is'].filter(Boolean) as string[],
      fetchedAt: Date.now(),
    };

    this.cache.set(family, { info, fetchedAt: info.fetchedAt });
    return info;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
