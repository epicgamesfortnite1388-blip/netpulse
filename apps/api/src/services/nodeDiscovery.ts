/**
 * Node discovery — a bounded search for a node worth connecting to, at a
 * depth the user chooses.
 *
 * The honesty rule this service exists to enforce: a depth that was not run is
 * never reported as if it had been. `turbo` proves a TCP handshake and says so;
 * `ironclad` proves a real proxied request and says that instead. The report
 * always states which, because "found 7 nodes" means something very different
 * at each depth.
 *
 * Bounds: the profile's candidate limit is a hard cap (a caller may ask for
 * fewer, never more), probes run in a bounded pool, and every probe resolves
 * with a classified failure rather than throwing.
 */
import {
  scanProfile,
  type DiscoveryOutcome,
  type DiscoveryReport,
  type ScanDepth,
  type ScanProfileId,
} from '@netpulse/shared';

export interface DiscoveryCandidate {
  id: string;
  name: string | null;
  host: string;
  port: number;
  protocol: string;
}

export interface DiscoveryProbeResult {
  ok: boolean;
  latencyMs: number | null;
  failure: string | null;
}

export interface NodeDiscoveryDeps {
  /** Candidate pool, newest/best-first, already restricted to dialable rows. */
  pickCandidates(opts: { limit: number; protocol?: string }): DiscoveryCandidate[];
  /** Probe one node at one depth. Must never throw — classify instead. */
  probe(nodeId: string, depth: ScanDepth, timeoutMs: number): Promise<DiscoveryProbeResult>;
  log: { warn(msg: string): void };
  /** Optional progress fan-out (`done`/`total` candidates). */
  onProgress?: (p: { done: number; total: number; profile: ScanProfileId }) => void;
}

export class NodeDiscoveryService {
  constructor(private readonly deps: NodeDiscoveryDeps) {}

  async run(req: { profile: ScanProfileId; limit?: number; protocol?: string }): Promise<DiscoveryReport> {
    const startedAt = Date.now();
    const profile = scanProfile(req.profile);
    // A caller may narrow the search, never widen it past the profile's budget.
    const limit = Math.max(1, Math.min(req.limit ?? profile.candidateLimit, profile.candidateLimit));

    const candidates = this.deps
      .pickCandidates({ limit, ...(req.protocol ? { protocol: req.protocol } : {}) })
      .slice(0, limit);

    if (candidates.length === 0) {
      return {
        profile: profile.id,
        probed: 0,
        passed: 0,
        outcomes: [],
        winner: null,
        summary: 'No candidates matched — import node sources or widen the protocol filter.',
        tookMs: Date.now() - startedAt,
      };
    }

    const outcomes = await this.probeAll(candidates, profile.depth, profile.timeoutMs, profile.concurrency, profile.id);

    const passed = outcomes.filter((o) => o.depth === profile.depth && o.failure === null);
    // Rank by measured latency; a candidate with no latency measurement can
    // still have passed (icmp-less paths) and sorts last rather than first.
    const winner = [...passed].sort((a, b) => (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY))[0] ?? null;

    return {
      profile: profile.id,
      probed: outcomes.length,
      passed: passed.length,
      outcomes,
      winner,
      summary: summarise(profile.id, profile.depth, outcomes.length, passed.length, winner),
      tookMs: Date.now() - startedAt,
    };
  }

  /** Bounded-concurrency pool; result order matches candidate order. */
  private async probeAll(
    candidates: DiscoveryCandidate[],
    depth: ScanDepth,
    timeoutMs: number,
    concurrency: number,
    profileId: ScanProfileId,
  ): Promise<DiscoveryOutcome[]> {
    const outcomes: DiscoveryOutcome[] = new Array<DiscoveryOutcome>(candidates.length);
    let next = 0;
    let done = 0;

    const worker = async () => {
      for (;;) {
        const index = next++;
        const candidate = candidates[index];
        if (!candidate) return;
        let result: DiscoveryProbeResult;
        try {
          result = await this.deps.probe(candidate.id, depth, timeoutMs);
        } catch (err) {
          // A probe must classify, not throw — but if one does, it counts as
          // a failed candidate rather than aborting the whole run.
          result = { ok: false, latencyMs: null, failure: err instanceof Error ? err.message : String(err) };
        }
        outcomes[index] = {
          nodeId: candidate.id,
          name: candidate.name,
          host: candidate.host,
          port: candidate.port,
          protocol: candidate.protocol,
          depth: result.ok ? depth : 'tcp',
          latencyMs: result.ok ? result.latencyMs : null,
          carrying: result.ok && depth === 'proxy',
          failure: result.ok ? null : result.failure ?? 'probe failed',
        };
        done += 1;
        this.deps.onProgress?.({ done, total: candidates.length, profile: profileId });
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, candidates.length)) }, worker));
    return outcomes.filter(Boolean);
  }
}

/** What was proven, in one line, without overclaiming. */
function summarise(
  profileId: ScanProfileId,
  depth: ScanDepth,
  probed: number,
  passed: number,
  winner: DiscoveryOutcome | null,
): string {
  const proven =
    depth === 'proxy'
      ? 'carried a real proxied request'
      : depth === 'tls'
        ? 'completed a TLS handshake'
        : 'answered a TCP handshake';
  const head = `${profileId} probed ${probed} candidate${probed === 1 ? '' : 's'} — ${passed} ${proven}.`;
  const tail =
    depth === 'proxy'
      ? ''
      : ' This does not prove the node relays traffic; run thorough or ironclad to confirm.';
  if (!winner) {
    return `${head}${tail} No node passed, so nothing was recommended.`.trim();
  }
  const where = winner.name ? `${winner.name} (${winner.host})` : winner.host;
  const latency = winner.latencyMs != null ? ` at ${Math.round(winner.latencyMs)} ms` : '';
  return `${head}${tail} Best: ${where}${latency}.`.trim();
}
