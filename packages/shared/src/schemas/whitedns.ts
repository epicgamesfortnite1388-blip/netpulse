import { z } from 'zod';

/**
 * WhiteDNS Soar DNS tunnel integration.
 *
 * The tunnel client is the separate WhiteDNS application; this surface only
 * verifies that the server-side DNS data plane is reachable and, when the
 * `soar-check` diagnostic binary is present on the host, that an authenticated
 * tunnel actually carries data. Nothing here provisions or touches the panel,
 * and no credentials or access paths are stored or returned.
 */

const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
// A label may not start or end with a hyphen and may contain only alphanumerics
// and hyphens. The full zone must be no longer than 253 ASCII characters.
const domainLabel = /(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?/;

export const WhitednsTunnelTestRequestSchema = z.object({
  /** Delegated tunnel zone served by the WhiteDNS server (e.g. gb6ysax....soar.abystral.dpdns.org). */
  zone: z.string().trim().min(1).max(253).regex(domainLabel, 'invalid domain name'),
  /** IPv4 address of the WhiteDNS authoritative/tunnel DNS server. */
  server: z.string().trim().min(1).max(64).regex(ipv4Regex, 'server must be an IPv4 address'),
  /** Base64 server public key from a WhiteDNS account profile (enables the data-plane test). */
  pubkey: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'pubkey must be base64-encoded').optional(),
  /** HTTPS destination fetched through the tunnel during the data-plane test. */
  url: z.string().url().optional().default('https://example.com/'),
  timeoutMs: z.coerce.number().int().min(1000).max(120_000).optional().default(60_000),
});

export type WhitednsTunnelTestRequest = z.infer<typeof WhitednsTunnelTestRequestSchema>;

export enum WhitednsErrorCode {
  INVALID_INPUT = 'whitedns_invalid_input',
  DNS_DELEGATION_FAILED = 'whitedns_dns_delegation_failed',
  UNREACHABLE = 'whitedns_unreachable',
  TUNNEL_NEGOTIATION_FAILED = 'whitedns_tunnel_negotiation_failed',
  UPSTREAM_FAILURE = 'whitedns_upstream_failure',
  INTERNAL = 'whitedns_internal',
}

export const WhitednsStageSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  ms: z.number().int().min(0).optional(),
});

export type WhitednsStage = z.infer<typeof WhitednsStageSchema>;

export const WhitednsTunnelTestResultSchema = z.object({
  ok: z.boolean(),
  stage: z.enum(['dns', 'reachability', 'tunnel', 'done', 'error']),
  stages: z.array(WhitednsStageSchema),
  checkedAt: z.number().int().min(0),
  tookMs: z.number().int().min(0),
  error: z.string().nullable(),
  code: z.nativeEnum(WhitednsErrorCode).optional(),
});

export type WhitednsTunnelTestResult = z.infer<typeof WhitednsTunnelTestResultSchema>;

export const WhitednsConfigSchema = z.object({
  zone: z.string().trim().min(1).max(253).optional(),
  server: z.string().trim().min(1).max(64).optional(),
  hasPubkey: z.boolean(),
});

export type WhitednsConfig = z.infer<typeof WhitednsConfigSchema>;
