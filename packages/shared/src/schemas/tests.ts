import { z } from 'zod';

export const IpFamilySchema = z.union([z.literal(4), z.literal(6)]);

export const SpeedTestRequestSchema = z.object({
  provider: z.string().trim().max(30).optional(),
  downloadStreams: z.number().int().min(1).max(8).optional(),
  uploadStreams: z.number().int().min(1).max(6).optional(),
  durationMs: z.number().int().min(3_000).max(30_000).optional(),
  family: IpFamilySchema.optional(),
});

export const RouteTestRequestSchema = z.object({
  target: z.string().trim().min(1).max(253),
  family: IpFamilySchema.optional(),
  maxHops: z.number().int().min(3).max(30).optional(),
  timeoutMs: z.number().int().min(300).max(5_000).optional(),
  measureLoss: z.boolean().optional(),
});
