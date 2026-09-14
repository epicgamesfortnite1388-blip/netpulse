import { z } from 'zod';

/**
 * Proxy-core engine management (download / verify / install / update).
 *
 * Binaries come ONLY from the official release CDN of each core, are verified
 * against the release's published SHA256 digests before being written into the
 * app's per-user cores drop-in folder, and are validated by spawning
 * `<core> version` before the install is reported as success.
 */

export const EngineIdSchema = z.enum(['xray', 'sing-box', 'v2ray']);

export type EngineId = z.infer<typeof EngineIdSchema>;

/** The user asked for an install/update; the backend owns everything else. */
export const EngineInstallRequestSchema = z.object({
  engine: EngineIdSchema,
  /** 'latest' resolves the newest release; a concrete tag pins the version. */
  version: z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
});

export type EngineInstallRequest = z.infer<typeof EngineInstallRequestSchema>;

export const EngineInstallResultSchema = z.object({
  engine: EngineIdSchema,
  status: z.enum(['installed', 'updated', 'already_current', 'failed']),
  /** concrete release tag that was installed (null when nothing was fetched) */
  version: z.string().nullable(),
  /** resolved binary path after install (null on failure) */
  path: z.string().nullable(),
  /** true when the downloaded archive matched the release's published digest */
  checksumVerified: z.boolean(),
  /** `<core> version` output's first line after a successful spawn check */
  versionOutput: z.string().nullable(),
  /** human-readable failure reason (already redacted) */
  error: z.string().nullable(),
  tookMs: z.number().int().min(0),
});

export type EngineInstallResult = z.infer<typeof EngineInstallResultSchema>;
