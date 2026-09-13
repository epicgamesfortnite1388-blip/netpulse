import type { ReputationVerdict } from '@netpulse/shared';

/**
 * A reputation provider classifies an IP using a real, external source
 * of reputation data (abuse databases, blocklists, commercial feeds).
 * Reachability alone must NEVER be reported as reputation.
 */
export interface ReputationProvider {
  readonly name: string;
  check(ip: string): Promise<ReputationVerdict | null>;
}
