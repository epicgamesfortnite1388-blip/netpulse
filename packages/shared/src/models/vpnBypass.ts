/**
 * Split-tunnel bypass rules (Aether-style routing rules).
 *
 * Destinations listed here are dialled DIRECT — they never enter the tunnel.
 * The overwhelmingly common use is keeping banking/streaming/local-service
 * traffic off a free public node (they break behind it, or they geolocate you
 * wrongly), plus keeping LAN and loopback traffic working while routed.
 *
 * Honesty contract: a rule list is only ever *applied* to the long-lived
 * tunnel core. Probe/test configs never carry bypass — a test that skipped the
 * node would be measuring the wrong path.
 */

export interface VpnBypassSettings {
  /** master switch; false means the list is kept but not applied */
  enabled: boolean;
  /** domain suffixes dialled direct (e.g. "bank.example.com", "example.com") */
  domains: string[];
  /** literal IPv4/IPv6 addresses and CIDR ranges dialled direct */
  ips: string[];
  /** destination ports dialled direct */
  ports: number[];
  /** always dial loopback / private (RFC1918, link-local, ULA) ranges direct */
  lan: boolean;
}

/** Bound on each list so a hostile settings payload cannot bloat core configs. */
export const BYPASS_MAX_ENTRIES = 200;

/** A normalized rule set — what the core config builders actually consume. */
export interface BypassRuleSet {
  domains: string[];
  ips: string[];
  ports: number[];
  lan: boolean;
}

export const EMPTY_BYPASS: VpnBypassSettings = {
  enabled: false,
  domains: [],
  ips: [],
  ports: [],
  lan: true,
};

/**
 * Accept the many shapes a user pastes and reduce them to a bare suffix:
 *   https://Bank.Example.com/login?x=1  →  bank.example.com
 *   *.example.com                       →  example.com
 *   .example.com                        →  example.com
 * Anything that is not a plausible hostname is dropped rather than guessed at.
 */
function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  // A pasted URL: drop scheme, then path/query/fragment.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  // Wildcard / leading-dot forms all mean "this suffix".
  s = s.replace(/^\*\.?/, '').replace(/^\./, '');
  // Strip a trailing dot (fully-qualified form) and any port.
  s = s.replace(/\.$/, '');
  s = s.replace(/:\d+$/, '');
  if (!s || s.length > 253) return null;
  // Must look like a hostname: labels of [a-z0-9-], no empty labels.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s)) return null;
  return s;
}

function isIpV4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Accept a literal address or a CIDR. IPv6 is checked structurally (non-empty
 * hex groups around colons) — full parsing is the core's job, and refusing a
 * valid v6 rule would be worse than passing an unusual-but-well-formed one.
 */
export function normalizeIpRule(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\*\.?/, '');
  // Strip a pasted scheme, but NEVER a path: in an address rule a slash is
  // the CIDR prefix, and cutting it would silently narrow 10.0.0.0/8 to the
  // single address 10.0.0.0 — a wrong rule that still looks plausible.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  if (!s) return null;

  const slash = s.lastIndexOf('/');
  const addr = slash >= 0 ? s.slice(0, slash) : s;
  const prefix = slash >= 0 ? s.slice(slash + 1) : null;
  const prefixNum = prefix === null ? null : Number(prefix);

  if (addr.includes(':')) {
    if (!/^[0-9a-f:]+$/.test(addr) || addr.split(':').length < 3) return null;
    if (prefixNum !== null && (!Number.isInteger(prefixNum) || prefixNum < 0 || prefixNum > 128)) return null;
    return prefixNum === null ? addr : `${addr}/${prefixNum}`;
  }
  if (!isIpV4(addr)) return null;
  if (prefixNum !== null && (!Number.isInteger(prefixNum) || prefixNum < 0 || prefixNum > 32)) return null;
  return prefixNum === null ? addr : `${addr}/${prefixNum}`;
}

/**
 * Reduce user input to the exact rule set the cores receive. Invalid entries
 * are dropped (never silently reinterpreted as something else) and duplicates
 * are collapsed so the generated config stays small.
 */
export function normalizeBypass(input: VpnBypassSettings | null | undefined): BypassRuleSet {
  if (!input) return { domains: [], ips: [], ports: [], lan: true };
  const domains = dedupe(input.domains.map(normalizeDomain)).slice(0, BYPASS_MAX_ENTRIES);
  const ips = dedupe(input.ips.map(normalizeIpRule)).slice(0, BYPASS_MAX_ENTRIES);
  const ports = dedupe(
    input.ports
      .map((p) => (typeof p === 'number' ? p : Number(p)))
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65_535),
  ).sort((a, b) => a - b);
  return { domains, ips, ports, lan: input.lan !== false };
}

function dedupe<T>(values: (T | null)[]): T[] {
  const out: T[] = [];
  for (const v of values) {
    if (v === null) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * True when these rules would not change routing at all — callers use it to
 * skip emitting empty routing blocks (an empty rule list is noise in a config
 * and some cores reject it).
 */
export function bypassIsEmpty(rs: BypassRuleSet): boolean {
  return !rs.lan && rs.domains.length === 0 && rs.ips.length === 0 && rs.ports.length === 0;
}

/** Human summary for the UI ("3 domains, 1 address, LAN"), or null when inert. */
export function bypassSummary(rs: BypassRuleSet): string | null {
  const parts: string[] = [];
  if (rs.domains.length > 0) parts.push(`${rs.domains.length} domain${rs.domains.length === 1 ? '' : 's'}`);
  if (rs.ips.length > 0) parts.push(`${rs.ips.length} address${rs.ips.length === 1 ? '' : 'es'}`);
  if (rs.ports.length > 0) parts.push(`${rs.ports.length} port${rs.ports.length === 1 ? '' : 's'}`);
  if (rs.lan) parts.push('LAN');
  return parts.length > 0 ? parts.join(', ') : null;
}
