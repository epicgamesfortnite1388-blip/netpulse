import { round } from '@netpulse/shared';

import type { RouteHop } from '@netpulse/shared';

export interface ParsedTraceLine {
  hop: number;
  ip: string | null;
  hostname: string | null;
  rtts: number[];
  stars: number;
  probes: number;
}

const IPV4_RE = /(\d{1,3}(?:\.\d{1,3}){3})/;
const IPV6_RE = /((?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4})?|::1|::)/;
const MS_RE = /(\d+(?:\.\d+)?)\s*(?:ms|мс)/gi;

/** Extract one traceroute hop line. Tolerates Windows (3 probes) and Unix (1-3) layouts. */
export function parseTraceLine(line: string): ParsedTraceLine | null {
  const trimmed = line.trim();
  const hopMatch = trimmed.match(/^(\d{1,3})\s+(.*)$/);
  if (!hopMatch) return null;
  const hop = Number(hopMatch[1]);
  const rest = hopMatch[2] ?? '';

  const ipMatch = rest.match(IPV4_RE);
  const ip = ipMatch?.[1] ?? rest.match(IPV6_RE)?.[1] ?? null;

  const rtts: number[] = [];
  for (const m of rest.matchAll(MS_RE)) {
    const v = Number(m[1]);
    if (!Number.isNaN(v)) rtts.push(v);
  }

  const stars = (rest.match(/\*/g) ?? []).length;
  // probe count: Windows prints 3 columns, Unix -q 2 prints 2, default 1-3
  const probes = Math.max(1, stars + rtts.length);

  // guard: hop numbers must be sane
  if (hop < 1 || hop > 64) return null;
  // a hop that resolved no IP and has no data is only valid with stars
  if (!ip && rtts.length === 0 && stars === 0) return null;
  // refuse treating final "Trace complete."-style lines as hops
  if (/trace complete|trace aborted/i.test(trimmed)) return null;

  return { hop, ip, hostname: null, rtts, stars, probes };
}

export interface ParsedTrace {
  hops: RouteHop[];
  /** true when at least one hop line was recognized */
  parsed: boolean;
}

/**
 * Convert raw traceroute output (Windows tracert -d or Unix traceroute -n)
 * into structured hops. Hop-level "loss" here means probe timeouts for that
 * hop — ICMP deprioritization makes this unreliable for intermediates, so
 * analysis must never attribute end-to-end loss to a single hop.
 */
export function parseTracerouteOutput(stdout: string): ParsedTrace {
  const hops: RouteHop[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parsedLine = parseTraceLine(line);
    if (!parsedLine) continue;

    const { hop, ip, rtts, stars, probes } = parsedLine;
    const avg = rtts.length > 0 ? round(rtts.reduce((a, b) => a + b, 0) / rtts.length, 1) : null;
    const loss = stars > 0 ? round((stars / probes) * 100, 1) : rtts.length > 0 ? 0 : null;

    hops.push({
      hop,
      ip,
      hostname: null,
      latencyMs: avg,
      packetLoss: loss,
      asn: null,
      org: null,
      country: null,
      status: ip === null ? 'no_response' : 'ok',
    });
  }
  return { hops, parsed: hops.length > 0 };
}

/**
 * Parse a Team Cymru `origin.asn.cymru.com` TXT payload (query domain is
 * `<reversed-ip>.origin.asn.cymru.com`). Live format varies between
 * "13335 | 104.18.41.0/24 | US | arin | 2014-03-28" and
 * "AS15169 | 8.8.8.0/24 | US | arin | 2005-03-30 | GOOGLE, US" —
 * the AS prefix and the org field are both optional.
 * fields: ASN | prefix | country | registry | allocated | org
 */
export function parseCymruOrigin(txt: string): { asn: number; org: string | null; country: string | null } | null {
  const m = txt.match(/(?:AS)?(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)(?:\|([^|]*))?/);
  if (!m) return null;
  const asn = Number(m[1]);
  if (!Number.isFinite(asn)) return null;
  const org = (m[6] ?? '').trim() || null;
  const country = (m[3] ?? '').trim() || null;
  return { asn, org, country };
}
