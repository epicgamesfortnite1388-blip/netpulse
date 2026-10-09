import type { NodeView } from '@netpulse/shared';

/**
 * How the globe picker describes a node's ping.
 *
 * Pure, no React and no fetching, so the wording that decides whether the panel
 * may show a number at all is unit-testable on its own.
 *
 * The rule these encode: a ping is shown only when something actually measured
 * one, and the panel always says WHICH measurement it is quoting. A TCP
 * handshake is not a proxy test and is never presented as one; an unmeasured
 * node reads "not measured" rather than 0 ms, because 0 ms is a claim, not a
 * missing value.
 */

/** Which measurement the displayed number came from. */
export type PingBasis = 'median-proxy' | 'last-proxy' | 'last-tcp' | 'none';

export interface PingReading {
  /** The number to display, or null when nothing has ever been measured. */
  ms: number | null;
  basis: PingBasis;
  /** The value as shown, e.g. "84 ms" / "not measured". */
  value: string;
  /** Why we believe it, in words. Shown next to the number. */
  basisLabel: string;
  /** A TCP handshake is weaker evidence than a real proxy test. */
  degraded: boolean;
}

type PingSource = Pick<NodeView, 'medianProxyMs' | 'lastProxyMs' | 'lastTcpMs'>;

/** Round the way the rest of the map does: sub-10ms keeps a decimal. */
export function pingMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

/**
 * The one number the picker is willing to show for this node, and what it is.
 *
 * Median first: one recent test is a bad estimate of how a node feels, and the
 * median over recent tests is already computed server-side from real probes.
 */
export function readPing(node: PingSource): PingReading {
  if (node.medianProxyMs != null) {
    return { ms: node.medianProxyMs, basis: 'median-proxy', value: pingMs(node.medianProxyMs), basisLabel: 'median of recent proxy tests', degraded: false };
  }
  if (node.lastProxyMs != null) {
    return { ms: node.lastProxyMs, basis: 'last-proxy', value: pingMs(node.lastProxyMs), basisLabel: 'last successful proxy test', degraded: false };
  }
  if (node.lastTcpMs != null) {
    return {
      ms: node.lastTcpMs,
      basis: 'last-tcp',
      value: pingMs(node.lastTcpMs),
      basisLabel: 'TCP handshake only — not a proxy test',
      degraded: true,
    };
  }
  return { ms: null, basis: 'none', value: 'not measured', basisLabel: 'no latency measurement has been recorded for this node', degraded: false };
}

/** "Amsterdam, Netherlands" — only the parts that are actually known. */
export function pickerPlace(node: Pick<NodeView, 'city' | 'country'>): string {
  const parts = [node.city, node.country].filter((v): v is string => !!v && v.trim().length > 0);
  return parts.length > 0 ? parts.join(', ') : 'Location unknown';
}

/** "Fiber • AS9009" — the network, for telling two nodes in one city apart. */
export function pickerNetwork(node: Pick<NodeView, 'isp' | 'organization' | 'asn'>): string | null {
  const org = node.isp ?? node.organization;
  const asn = node.asn != null ? `AS${node.asn}` : null;
  const bits = [org, asn].filter((v): v is string => !!v && v.trim().length > 0);
  return bits.length > 0 ? bits.join(' · ') : null;
}

/**
 * The line that tells the user they got the server they picked.
 *
 * Deliberately built from the profile name, the place and the ping the panel
 * just showed — never host, port, protocol parameters or anything else that
 * would let the confirmation double as a partial config dump. The whole point
 * of this path is that the client never receives a rebuildable link.
 */
export function selectionConfirmation(input: {
  profileName: string;
  node: Pick<NodeView, 'city' | 'country' | 'isp' | 'organization' | 'asn'>;
  ping: PingReading;
}): {
  title: string;
  lines: string[];
} {
  const network = pickerNetwork(input.node);
  return {
    title: `${input.profileName} is ready`,
    lines: [
      `Location: ${pickerPlace(input.node)}`,
      network ? `Network: ${network}` : null,
      `Ping: ${input.ping.value}${input.ping.ms != null ? ` (${input.ping.basisLabel})` : ''}`,
    ].filter((v): v is string => v !== null),
  };
}