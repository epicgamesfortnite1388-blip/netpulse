/**
 * Discovery profiles — how hard a "find me a working node" run searches.
 *
 * The trade-off is the one Aether exposes as scan modes: a run emits probe
 * traffic at whatever rate it probes, and on a censored or metered link that
 * traffic is itself a liability. So each profile states, honestly and up
 * front, both how deep it validates and roughly how many candidates it will
 * touch — a user can choose "fewest probes" or "prove it actually carries
 * traffic" instead of getting one hard-coded behaviour.
 *
 * Depth means exactly this:
 *   tcp   — the handshake connected
 *   tls   — TLS finished (the node speaks real TLS, not just a bare socket)
 *   proxy — a real request was carried through a local core, i.e. the node
 *           provably relays traffic
 */

export type ScanProfileId = 'turbo' | 'balanced' | 'thorough' | 'stealth' | 'ironclad';

/** How deeply each candidate is validated. */
export type ScanDepth = 'tcp' | 'tls' | 'proxy';

export interface ScanProfile {
  id: ScanProfileId;
  label: string;
  /** one-line trade-off statement, shown in the UI */
  summary: string;
  /** hard cap on candidates a single run may probe */
  candidateLimit: number;
  /** deepest validation applied to each candidate */
  depth: ScanDepth;
  /** per-candidate budget (ms) */
  timeoutMs: number;
  /** candidates probed concurrently */
  concurrency: number;
  /** confirm the winner by reading its exit IP through the tunnel */
  verifyExit: boolean;
  /** honest label for the UI: roughly how many candidates a full run touches */
  probeBudget: number;
}

export const SCAN_PROFILES: Record<ScanProfileId, ScanProfile> = {
  turbo: {
    id: 'turbo',
    label: 'Turbo',
    summary: 'Fastest, but touches the most candidates — use on a connection where scanning is not itself a problem.',
    candidateLimit: 40,
    depth: 'tcp',
    timeoutMs: 1_000,
    concurrency: 12,
    verifyExit: false,
    probeBudget: 40,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    summary: 'Sensible default: TLS-validated candidates, moderate probe volume.',
    candidateLimit: 24,
    depth: 'tls',
    timeoutMs: 2_000,
    concurrency: 8,
    verifyExit: false,
    probeBudget: 24,
  },
  thorough: {
    id: 'thorough',
    label: 'Thorough',
    summary: 'Every candidate must carry a real proxied request before it counts.',
    candidateLimit: 16,
    depth: 'proxy',
    timeoutMs: 5_000,
    concurrency: 4,
    verifyExit: true,
    probeBudget: 16,
  },
  stealth: {
    id: 'stealth',
    label: 'Stealth',
    summary: 'Fewest probes of any profile — slow and narrow, for links where scanning draws attention or costs money.',
    candidateLimit: 6,
    depth: 'tls',
    timeoutMs: 3_000,
    concurrency: 2,
    verifyExit: false,
    probeBudget: 6,
  },
  ironclad: {
    id: 'ironclad',
    label: 'Ironclad',
    summary: 'Slowest: opens a real tunnel through each candidate and sends a real request before trusting it.',
    candidateLimit: 4,
    depth: 'proxy',
    timeoutMs: 8_000,
    concurrency: 1,
    verifyExit: true,
    probeBudget: 4,
  },
};

export const SCAN_PROFILE_IDS: ScanProfileId[] = ['turbo', 'balanced', 'thorough', 'stealth', 'ironclad'];

export function isScanProfileId(v: unknown): v is ScanProfileId {
  return typeof v === 'string' && (SCAN_PROFILE_IDS as string[]).includes(v);
}

export function scanProfile(id: ScanProfileId): ScanProfile {
  return SCAN_PROFILES[id];
}

/**
 * Ordering value for discovery depth — a deeper validation is strictly
 * stronger evidence than a shallower one, so a run never downgrades a
 * candidate's verdict by re-testing it more cheaply.
 */
export function depthRank(depth: ScanDepth): number {
  return depth === 'proxy' ? 2 : depth === 'tls' ? 1 : 0;
}
