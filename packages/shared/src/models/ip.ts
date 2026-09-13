import type { IpFamily } from './common';

export interface AsnInfo {
  asn: number | null;
  org: string | null;
}

/**
 * Reputation is only ever populated by a real reputation provider.
 * No provider = empty array. Never infer "clean" from reachability.
 */
export interface ReputationVerdict {
  provider: string;
  classification: string;
  score: number | null;
  detail: string;
}

export interface IpInfo {
  ip: string;
  family: IpFamily;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  org: string | null;
  asn: AsnInfo;
  reverseDns: string | null;
  /** Cloudflare datacenter code serving the request, when known */
  edgeLocation: string | null;
  reputation: ReputationVerdict[];
  sources: string[];
  fetchedAt: number;
}
