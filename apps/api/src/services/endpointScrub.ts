import { nodeLabel } from './nodeView';

/**
 * The read side of the endpoint boundary, for data that was STORED before it
 * knew it would be shown.
 *
 * `toWebDTO` withholds a node's address from everything it serializes, but
 * some responses are assembled from rows written earlier — stored traceroutes,
 * probe error strings, route-history summaries. The map traces stored-node
 * targets through the ordinary route pipeline, so a node's address can sit in
 * `params.target`, in a trace's `resolvedIp`, in the destination hop, or in an
 * analysis sentence ("packet loss to 198.51.100.7 measured at …") long before
 * anyone looks at it. Handing one of those rows back verbatim would leak the
 * address around the DTO boundary rather than through it.
 *
 * So a response built from stored rows passes through here first:
 *
 *   - a value that IS a node's address under an address key (`ip`,
 *     `resolvedIp`, `hostname`) becomes `null` — the field's type says it can
 *     be absent, and absent reads as "not sent" rather than as broken data;
 *   - an address inside free text (targets, error messages, findings) is
 *     replaced with the node's `label`, the same non-address identity the DTO
 *     uses, so the sentence still reads as a sentence; when the address is
 *     written with its port (`host:9443`), both go together, because masking
 *     the host alone would strand the port — the other half of the dial
 *     address, and half of the node's configuration;
 *   - anything that does not match a stored node is passed through untouched.
 *     Public resolvers, game doors and hosts the user typed themselves are not
 *     node configuration, and masking them would hide nothing while breaking
 *     the surfaces that legitimately name them.
 *
 * The scrub is deliberately value-based, not key-based: an address can hide in
 * any string, and a key filter would miss it the moment a field is renamed.
 * What makes it safe to run over arbitrary rows is the same thing that makes
 * the DTO safe: the match set is exactly the stored nodes' `host`/`ipv4`/
 * `ipv6` — nothing else can trigger a rewrite.
 */

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A boundary-aware pattern for one address, so a mask can never match inside a
 * longer value: `198.51.100.7` must not fire inside `198.51.100.70`, and a
 * hostname must not fire inside `list-leak.example.test.example.test`'s label.
 * Over-masking a fragment would be a wrong sentence; under-masking would be a
 * leak, so the boundaries are conservative on both sides.
 */
interface Boundary {
  prefix: string;
  suffix: string;
  flags: string;
}

/** The boundaries an occurrence of `address` must sit between to be a match. */
function boundaryFor(address: string): Boundary | null {
  const a = address.trim();
  if (a.length === 0) return null;
  if (IPV4.test(a)) return { prefix: '(?<![\\d.])', suffix: '(?![\\d.])', flags: 'g' };
  if (a.includes(':') && IPV6.test(a)) return { prefix: '(?<![0-9a-f:])', suffix: '(?![0-9a-f:])', flags: 'gi' };
  return { prefix: '(?<![a-z0-9-])', suffix: '(?![a-z0-9-])', flags: 'gi' };
}

function addressPattern(address: string): RegExp | null {
  const b = boundaryFor(address);
  if (!b) return null;
  return new RegExp(`${b.prefix}${escapeRegExp(address.trim())}${b.suffix}`, b.flags);
}

/**
 * `address:port` — the form a dialled endpoint takes in a probe error
 * (`connect ETIMEDOUT host:9443`). Built before the bare-address pattern so the
 * two are masked as one unit: bare-first would replace the host and leave the
 * port standing behind a label.
 *
 * The port is only ever matched attached to one of that node's own addresses,
 * never on its own. A bare `443` is an ordinary value elsewhere (map targets
 * carry public hosts on well-known ports), so masking the number globally would
 * rewrite unrelated traffic while hiding nothing.
 */
function portedAddressPattern(address: string, port: number): RegExp | null {
  const b = boundaryFor(address);
  if (!b) return null;
  return new RegExp(`${b.prefix}${escapeRegExp(address.trim())}:${port}(?!\\d)`, b.flags);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export interface EndpointScrubber {
  /** 0 when there is nothing to hide — callers skip their work entirely. */
  readonly size: number;
  /** The node's label when `value` IS one of its addresses, else null. */
  exactLabel(value: string): string | null;
  /** Every occurrence of every address in `text`, replaced by its label. */
  mask(text: string): string;
}

interface Entry {
  label: string;
  addresses: readonly string[];
  patterns: RegExp[];
}

/**
 * Build the scrubber from `{label, addresses}` entries — the DTO's own
 * substitute identity paired with the values that must not ride out. Rows are
 * mapped through `entriesFromRows` at the call sites that hold stored rows.
 */
export function makeScrubber(
  entries: Array<{ label: string; addresses: readonly string[]; ports?: readonly number[] }>,
): EndpointScrubber {
  const built: Entry[] = [];
  const exact = new Map<string, string>();
  for (const entry of entries) {
    const addresses = entry.addresses.map((a) => a.trim()).filter((a) => a.length > 0);
    if (addresses.length === 0) continue;
    const ports = (entry.ports ?? []).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
    const patterns: RegExp[] = [];
    // Ported forms first: `host:9443` must be consumed as one unit, or the
    // bare-host pattern would replace the host and strand the port.
    for (const address of addresses) {
      for (const port of ports) {
        const ported = portedAddressPattern(address, port);
        if (ported) patterns.push(ported);
      }
    }
    for (const address of addresses) {
      // First node wins a contested address; deterministic enough that two
      // responses in a row agree on what a shared address is called.
      const key = normalize(address);
      if (!exact.has(key)) exact.set(key, entry.label);
      // Fresh global pattern per use: `lastIndex` on a shared /g RegExp would
      // make masking depend on call order.
      const pattern = addressPattern(address);
      if (pattern) patterns.push(pattern);
    }
    built.push({ label: entry.label, addresses, patterns });
  }

  return {
    size: built.length,
    exactLabel(value: string): string | null {
      if (typeof value !== 'string') return null;
      return exact.get(normalize(value)) ?? null;
    },
    mask(text: string): string {
      if (typeof text !== 'string' || text.length === 0) return text;
      let out = text;
      for (const entry of built) {
        for (const pattern of entry.patterns) {
          out = out.replace(new RegExp(pattern.source, pattern.flags), entry.label);
        }
      }
      return out;
    },
  };
}

/** One scrubber covering every stored node in `rows`. Accepts the slim
 *  address-index projection from `listAddressRows()` as well as full rows —
 *  the scrubber only ever reads these six fields. */
export interface EndpointRow {
  host: string;
  ipv4: string[];
  ipv6: string[];
  /** The node's dial port; its `host:port` form is masked as one unit. */
  port?: number | null;
  remark: string | null;
  protocol: string;
  canonicalFingerprint?: string;
  id?: string;
}

export function scrubberFromRows(rows: readonly EndpointRow[]): EndpointScrubber {
  return makeScrubber(
    rows.map((row) => ({
      label: nodeLabel(row),
      addresses: [row.host, ...row.ipv4, ...row.ipv6],
      ports: row.port != null ? [row.port] : [],
    })),
  );
}

/**
 * Keys whose value IS an address when it matches: those become `null` instead
 * of being rewritten to a label, because `ip: <label>` would render as a
 * corrupted address while `ip: null` is the type's own "absent" answer.
 */
const ADDRESS_KEYS = new Set(['ip', 'resolvedIp', 'probedIp', 'hostname']);

/**
 * A structural copy of `value` with node addresses removed from it. Pure: the
 * input (a stored row) is never mutated, because the same row may be read
 * again on the next request.
 */
export function scrubEndpoints<T>(value: T, scrubber: EndpointScrubber): T {
  if (scrubber.size === 0) return value;
  return walk(value, scrubber, null) as T;
}

function walk(value: unknown, scrubber: EndpointScrubber, key: string | null): unknown {
  if (typeof value === 'string') {
    if (key != null && ADDRESS_KEYS.has(key) && scrubber.exactLabel(value) != null) return null;
    return scrubber.mask(value);
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, scrubber, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, scrubber, k);
    }
    return out;
  }
  return value;
}
