import { z } from 'zod';

import { SCAN_PROFILE_IDS } from '../models/scanProfile';

const scanProfileSchema = z.enum(SCAN_PROFILE_IDS as [string, ...string[]]);

/** POST /vpn/tunnel/quick — retry remembered gateways, then discover. */
export const QuickConnectSchema = z.object({
  /** point the OS system proxy at the tunnel when it comes up */
  systemProxy: z.boolean().optional(),
  /** profile used for the fallback discovery run */
  profile: scanProfileSchema.optional(),
  /** how many remembered gateways may be retried before discovering (0 = skip memory) */
  maxMemoryAttempts: z.number().int().min(0).max(12).optional(),
  /** TUN mode: capture all system traffic through a sing-box TUN gateway */
  tun: z.boolean().optional(),
  /** Opaque client-generated id used only to stream this run's live activity. */
  activityId: z.string().uuid().optional(),
});

export type QuickConnectRequest = z.infer<typeof QuickConnectSchema>;

/** POST /vpn/discover — bounded search for a node that provably carries traffic. */
export const DiscoverSchema = z.object({
  profile: scanProfileSchema.optional(),
  /** optional hard cap on candidates, never above the profile's own limit */
  limit: z.number().int().min(1).max(60).optional(),
  /** restrict discovery to one protocol family, e.g. only sing-box-served hysteria2 */
  protocol: z.string().trim().min(1).max(32).optional(),
});

export type DiscoverRequest = z.infer<typeof DiscoverSchema>;
