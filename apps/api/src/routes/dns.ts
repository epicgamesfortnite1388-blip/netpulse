import { DNS_PROVIDER_GROUPS, providerById } from '../services/dnsResolverCatalog';
import { assertPublicDohUrl, dnssecValidating } from '../providers/dns/resolver';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';
import type { DnsServerSpec } from '@netpulse/shared';

const TestSchema = z.object({
  providers: z.array(z.string()).optional(),
  probes: z.coerce.number().int().min(1).max(10).optional(),
  timeoutMs: z.coerce.number().int().min(500).max(10_000).optional(),
  transport: z.enum(['udp', 'doh', 'dot', 'both']).optional(),
});

const CustomResolverSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  ipv4: z.string().nullable().optional(),
  ipv6: z.string().nullable().optional(),
  dohUrl: z.string().url().nullable().optional(),
  dotHost: z.string().min(1).nullable().optional(),
  dnssec: z.boolean().optional(),
});

export function registerDnsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Get the full catalog grouped by provider
  app.get('/api/v1/dns/providers', async () => ({
    groups: DNS_PROVIDER_GROUPS,
    total: DNS_PROVIDER_GROUPS.reduce((sum: number, g: { resolvers: unknown[] }) => sum + g.resolvers.length, 0),
  }));

  // Get a single provider group with all its variants
  app.get('/api/v1/dns/providers/:providerId', async (req) => {
    const { providerId } = req.params as { providerId: string };
    const group = DNS_PROVIDER_GROUPS.find((g) => g.id === providerId);
    if (!group) return null;
    return group;
  });

  // Get a single resolver by ID
  app.get('/api/v1/dns/providers/:resolverId/resolver', async (req) => {
    const { resolverId } = req.params as { resolverId: string };
    const resolver = providerById(resolverId);
    if (!resolver) return null;
    return resolver;
  });

  // Run DNS benchmark
  app.post(
    '/api/v1/dns/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = TestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const testId = crypto.randomUUID();
      void ctx.services.dns.runTest(parsed.data, testId).catch(() => undefined);
      return reply.status(202).send({ testId });
    },
  );

  // DNS leak test
  app.post(
    '/api/v1/dns/leak-test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const testId = crypto.randomUUID();
      void ctx.services.dns.leakTest(testId).catch(() => undefined);
      return reply.status(202).send({ testId });
    },
  );

  // DNSSEC validation probe for a specific resolver
  app.post(
    '/api/v1/dns/providers/:id/dnssec',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const { id } = req.params as { id: string };
      const spec = providerById(id);
      if (!spec?.ipv4) {
        return { providerId: id, dnssec: null, note: 'resolver unknown or has no IPv4 address' };
      }
      const dnssec = await dnssecValidating(spec.ipv4, 2_500);
      return { providerId: id, dnssec, transport: 'udp' };
    },
  );

  // Add a custom resolver to user's catalog
  app.post(
    '/api/v1/dns/providers/custom',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = CustomResolverSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      
      const blocked = ['169.254.169.254', '100.100.100.100'].includes(parsed.data.ipv4 ?? '') || ['169.254.169.254'].includes(parsed.data.ipv6 ?? '');
      if (blocked || (parsed.data.ipv4 && !isPublicIp(parsed.data.ipv4)) || (parsed.data.ipv6 && !isPublicIp(parsed.data.ipv6))) {
        throw Object.assign(new Error('Custom resolver addresses must be public Internet addresses (private, loopback, link-local and metadata ranges are rejected).'), { statusCode: 400 });
      }
      // DoH SSRF guard (defense in depth — the query layer re-checks): only
      // https URLs whose host is a public literal are accepted here.
      if (parsed.data.dohUrl) {
        try {
          assertPublicDohUrl(parsed.data.dohUrl);
        } catch (err) {
          throw Object.assign(new Error(err instanceof Error ? err.message : 'DoH URL rejected'), { statusCode: 400 });
        }
      }
      if (parsed.data.dotHost && /[^a-zA-Z0-9._\-]/.test(parsed.data.dotHost)) {
        throw Object.assign(new Error('DoT host must be a plain hostname or IP literal.'), { statusCode: 400 });
      }
      const spec: DnsServerSpec = {
        id: `custom-${parsed.data.id}`,
        name: parsed.data.name,
        ipv4: parsed.data.ipv4 ?? null,
        ipv6: parsed.data.ipv6 ?? null,
        dohUrl: parsed.data.dohUrl ?? null,
        dotHost: parsed.data.dotHost ?? null,
        dnssec: parsed.data.dnssec ?? false,
        kind: 'custom',
        category: 'custom',
        verified: false,
      };
      
      // Store in settings as user-added custom resolver
      const current = ctx.services.settings.get();
      const customResolvers = current.network.customResolvers ?? [];
      customResolvers.push(spec);
      ctx.services.settings.update({ network: { customResolvers } });
      
      return { added: spec };
    },
  );

  // Remove a custom resolver
  app.delete('/api/v1/dns/providers/custom/:id', async (req) => {
    const { id } = req.params as { id: string };
    const current = ctx.services.settings.get();
    const customResolvers = current.network.customResolvers ?? [];
    const filtered = customResolvers.filter((r) => r.id !== `custom-${id}`);
    ctx.services.settings.update({ network: { customResolvers: filtered } });
    return { removed: true };
  });

  // Get all custom resolvers
  app.get('/api/v1/dns/providers/custom', async () => {
    const current = ctx.services.settings.get();
    return current.network.customResolvers ?? [];
  });

  // Multi-signal DNSSEC diagnostic for a resolver
  app.post(
    '/api/v1/dns/providers/:id/dnssec-deep',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const { id } = req.params as { id: string };
      const spec = providerById(id);
      if (!spec) {
        return { providerId: id, classification: 'unknown', detail: 'Resolver not found in the catalog.' };
      }
      return ctx.services.dns.dnssecDeep(spec);
    },
  );

  // Benchmark history time series
  app.get('/api/v1/dns/history', async (req) => {
    const q = req.query as { range?: string; providerId?: string; transport?: string };
    const range = ['today', '24h', '7d', '30d'].includes(q.range ?? '') ? (q.range as 'today' | '24h' | '7d' | '30d') : '24h';
    const transport = q.transport === 'doh' || q.transport === 'dot' ? q.transport : q.transport === 'udp' ? 'udp' : undefined;
    return ctx.services.dns.history(range, { providerId: q.providerId, transport });
  });

  // Resolver recommendation from the latest benchmark batch
  app.get('/api/v1/dns/recommend', async (req) => {
    const q = req.query as { profile?: string; transport?: string };
    const profiles = ['fastest', 'reliable', 'privacy', 'security', 'family', 'gaming', 'balanced'] as const;
    const profile = profiles.includes(q.profile as (typeof profiles)[number]) ? (q.profile as (typeof profiles)[number]) : 'balanced';
    const transport = q.transport === 'doh' || q.transport === 'dot' || q.transport === 'udp' ? q.transport : 'udp';
    return ctx.services.dns.recommend(profile, transport);
  });
}

/** True when `ip` is a globally routable IPv4/IPv6 address (rejects private/metadata ranges). */
function isPublicIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 0) return false; // 0.0.0.0/8
    if (a === 10) return false; // private
    if (a === 127) return false; // loopback
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast + reserved
    if (a === 192 && (b === 0 || b === 2)) return false; // 192.0.0.0/24, 192.0.2.0/24 doc
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false; // doc
    if (a === 203 && b === 0 && Number(v4[3]) === 113) return false; // doc
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1' || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return false; // unspecified/loopback/link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return false; // ULA
  if (v6.startsWith('ff')) return false; // multicast
  if (v6.includes('::ffff:')) return isPublicIp(v6.split('::ffff:')[1]!);
  return true;
}
