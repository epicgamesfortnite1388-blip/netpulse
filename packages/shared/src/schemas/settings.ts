import { z } from 'zod';

import type { AppSettings } from '../models/settings';

/**
 * Targets are validated both by schema (syntax) and by the target guard
 * on the API side (SSRF: resolved addresses must not be private/reserved).
 */
export const TargetSchema = z
  .string()
  .trim()
  .min(1, 'Target is required')
  .max(253, 'Target is too long')
  .regex(
    /^[a-zA-Z0-9._\-:\[\]]+$/,
    'Target may only contain letters, digits, dots, dashes, colons and brackets',
  );

export const PingTestRequestSchema = z.object({
  target: TargetSchema,
  count: z.number().int().min(1).max(100).default(4),
  timeoutMs: z.number().int().min(100).max(10_000).default(4_000),
  family: z.union([z.literal(4), z.literal(6)]).optional(),
});

export type PingTestRequest = z.infer<typeof PingTestRequestSchema>;

const customResolverSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  ipv4: z.string().nullable(),
  ipv6: z.string().nullable(),
  dohUrl: z.string().url().nullable(),
  dotHost: z.string().nullable(),
  dnssec: z.boolean(),
  kind: z.enum(['public', 'custom']),
  category: z.enum(['standard', 'unfiltered', 'privacy', 'security', 'family', 'custom']),
  source: z.string().optional(),
  verified: z.boolean(),
  verifiedAt: z.number().optional(),
  skipBenchmarkReason: z.string().optional(),
  note: z.string().optional(),
});

export const VpnSelfTestResultSchema = z.object({
  state: z.enum(['ok', 'unavailable', 'error']),
  detail: z.string().max(500),
  engines: z.record(z.string(), z.boolean()),
  profilesChecked: z.number().int().min(0),
  endpointsReachable: z.number().int().min(0).nullable(),
  checkedAt: z.number(),
  tookMs: z.number().int().min(0),
});

export const ScheduleSettingsSchema = z.object({
  dnsEnabled: z.boolean(),
  dnsIntervalMin: z.number().int().min(15).max(10_080),
  gamingEnabled: z.boolean(),
  gamingIntervalMin: z.number().int().min(15).max(10_080),
  gamingGameId: z.string().min(1).max(80).nullable(),
  vpnSelfTestEnabled: z.boolean(),
  vpnSelfTestIntervalMin: z.number().int().min(15).max(10_080),
});

const weightsSchema = z
  .object({
    latency: z.number().min(0).max(100),
    packetLoss: z.number().min(0).max(100),
    jitter: z.number().min(0).max(100),
    throughput: z.number().min(0).max(100),
    routeQuality: z.number().min(0).max(100),
    load: z.number().min(0).max(100),
  })
  .refine((w) => Math.abs(w.latency + w.packetLoss + w.jitter + w.throughput + w.routeQuality + w.load - 100) < 0.001, {
    message: 'Weights must sum to 100',
  });

export const SettingsSchema = z.object({
  general: z.object({
    theme: z.enum(['dark', 'light', 'system']),
    language: z.string().min(2).max(10),
    units: z.enum(['metric', 'imperial']),
    notifications: z.boolean(),
  }),
  network: z.object({
    ipPreference: z.enum(['auto', '4', '6']),
    dnsPreference: z.string().nullable(),
    testTimeoutMs: z.number().int().min(500).max(30_000),
    probes: z.number().int().min(1).max(50),
    customResolvers: z.array(customResolverSchema).max(50),
  }),
  diagnostics: z.object({
    defaultTestTarget: TargetSchema,
    pingCount: z.number().int().min(1).max(100),
    routeDepth: z.number().int().min(3).max(64),
    packetLossThresholdPct: z.number().min(0).max(100),
  }),
  optimization: z.object({
    weights: weightsSchema,
    preferredRegions: z.array(z.string().min(1).max(50)).max(50),
    preferredProtocols: z.array(z.string().min(1).max(20)).max(20),
  }),
  vpn: z.object({
    killSwitch: z.boolean(),
    autoConnect: z.boolean(),
    autoSelectServer: z.boolean(),
    dnsThroughVpn: z.boolean(),
    ipv6Behavior: z.enum(['block', 'allow', 'auto']),
  }),
  proxyEngine: z.object({
    preferred: z.enum(['auto', 'sing-box', 'xray', 'v2ray']),
  }),
  geoProvider: z.object({
    /** 'auto' = ipwho.is first (richer verdicts) with geojs.io failover. */
    preferred: z.enum(['auto', 'ipwho.is', 'geojs.io']),
  }),
  automation: z.object({
    autoTestNodes: z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().min(10).max(240),
    }),
  }),
  scheduling: ScheduleSettingsSchema,
});

export const DEFAULT_SETTINGS: AppSettings = {
  general: { theme: 'dark', language: 'en', units: 'metric', notifications: true },
  network: { ipPreference: 'auto', dnsPreference: null, testTimeoutMs: 5_000, probes: 4, customResolvers: [] },
  diagnostics: {
    defaultTestTarget: '1.1.1.1',
    pingCount: 10,
    routeDepth: 30,
    packetLossThresholdPct: 2,
  },
  optimization: {
    weights: { latency: 30, packetLoss: 20, jitter: 15, throughput: 20, routeQuality: 10, load: 5 },
    preferredRegions: [],
    preferredProtocols: [],
  },
  vpn: {
    killSwitch: false,
    autoConnect: false,
    autoSelectServer: true,
    dnsThroughVpn: true,
    ipv6Behavior: 'auto',
  },
  proxyEngine: {
    preferred: 'auto',
  },
  geoProvider: {
    preferred: 'auto',
  },
  scheduling: {
    dnsEnabled: false,
    dnsIntervalMin: 60,
    gamingEnabled: false,
    gamingIntervalMin: 60,
    gamingGameId: null,
    vpnSelfTestEnabled: true,
    vpnSelfTestIntervalMin: 60,
  },
  automation: {
    autoTestNodes: { enabled: true, intervalMinutes: 30 },
  },
};

export const SettingsPatchSchema = z
  .object({
    general: z
      .object({
        theme: z.enum(['dark', 'light', 'system']),
        language: z.string().min(2).max(10),
        units: z.enum(['metric', 'imperial']),
        notifications: z.boolean(),
      })
      .partial(),
    network: z
      .object({
        ipPreference: z.enum(['auto', '4', '6']),
        dnsPreference: z.string().nullable(),
        testTimeoutMs: z.number().int().min(500).max(30_000),
        probes: z.number().int().min(1).max(50),
        customResolvers: z.array(customResolverSchema).max(50),
      })
      .partial(),
    diagnostics: z
      .object({
        defaultTestTarget: TargetSchema,
        pingCount: z.number().int().min(1).max(100),
        routeDepth: z.number().int().min(3).max(64),
        packetLossThresholdPct: z.number().min(0).max(100),
      })
      .partial(),
    optimization: z
      .object({
        // weight patches are complete sets so the sum-100 invariant holds
        weights: weightsSchema,
        preferredRegions: z.array(z.string().min(1).max(50)).max(50),
        preferredProtocols: z.array(z.string().min(1).max(20)).max(20),
      })
      .partial(),
    vpn: z
      .object({
        killSwitch: z.boolean(),
        autoConnect: z.boolean(),
        autoSelectServer: z.boolean(),
        dnsThroughVpn: z.boolean(),
        ipv6Behavior: z.enum(['block', 'allow', 'auto']),
      })
      .partial(),
    proxyEngine: z
      .object({
        preferred: z.enum(['auto', 'sing-box', 'xray', 'v2ray']),
      })
      .partial(),
    geoProvider: z
      .object({
        preferred: z.enum(['auto', 'ipwho.is', 'geojs.io']),
      })
      .partial(),
    automation: z
      .object({
        autoTestNodes: z
          .object({
            enabled: z.boolean(),
            intervalMinutes: z.number().min(10).max(240),
          })
          .partial(),
      })
      .partial(),
    scheduling: ScheduleSettingsSchema.partial(),
  })
  .partial();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
