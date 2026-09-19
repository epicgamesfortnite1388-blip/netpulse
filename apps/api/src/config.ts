import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

// resolve the web bundle relative to this module (apps/api/src in dev,
// apps/api/dist in prod — both one directory deep under apps/api) so
// production start works from any cwd.
// Runtime-safe: ESM runtimes provide import.meta.dirname; the CJS desktop
// sidecar bundle does not, so fall back to the location of the calling file
// if available, otherwise cwd (the SPA is served by the Tauri window there
// and hasSpa simply stays false).
function resolveWebDist(): string {
  // ESM: use import.meta.dirname
  if (typeof import.meta !== 'undefined' && typeof (import.meta as { dirname?: string }).dirname === 'string') {
    return path.resolve((import.meta as { dirname: string }).dirname, '../../web/dist');
  }
  // CJS (desktop bundle): try to find web/dist relative to the executable
  // or the CWD. In desktop mode the SPA is served by Tauri, so this path
  // is only used for the hasSpa check and must not crash.
  const candidates = [
    path.resolve(process.cwd(), '../../web/dist'),
    path.resolve(process.execPath, '../../web/dist'),
    path.resolve('.', '../../web/dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  // Last resort: return a path that exists or will be created — the hasSpa
  // check will simply report false and the SPA route stays inactive.
  return candidates[0] ?? path.resolve(process.cwd(), '../../web/dist');
}
const WEB_DIST = resolveWebDist();

const EnvSchema = z.object({
  // PORT=0 (ephemeral) is useful in tests, so allow it
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATA_DIR: z.string().optional(),
  DEMO_DATA: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  // 12 h, not a week: the cookie authenticates EVERY mutating route from
  // loopback, so a stolen or leaked value should stop being useful the same day
  // it was minted. The web UI re-mints silently on 401, and the desktop app
  // uses the bearer token instead, so nothing depends on a long-lived cookie.
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  NETPULSE_SAFE_MODE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

/**
 * Origins allowed to call the API cross-origin.
 *
 * Dev origins cover `tauri dev` (Vite on 5173). The packaged webview serves
 * the UI from http(s)://tauri.localhost — a different origin from the loopback
 * sidecar — and every authed request triggers a CORS preflight, so this origin
 * MUST be allowlisted or the UI reports "Backend unreachable" while the
 * backend is healthy. Desktop origins are merged into the effective allowlist
 * for every runtime (web mode just never uses them).
 */
export const DESKTOP_WEBVIEW_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost'] as const;

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  tokenFile: string;
  webDist: string;
  demoMode: boolean;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  corsOrigins: string[];
  sessionTtlMs: number;
  isTest: boolean;
  /**
   * Safe Mode: launch with networking/VPN/scanners/monitors disabled so the
   * user can reach Settings and repair the installation. The GUI always
   * starts; Safe Mode only degrades backend capabilities.
   */
  safeMode: boolean;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  overrides?: Partial<AppConfig>,
): AppConfig {
  const parsed = EnvSchema.parse(env);
  const dataDir = path.resolve(parsed.DATA_DIR ? parsed.DATA_DIR : path.join(cwd, '.data'));
  const config: AppConfig = {
    port: parsed.PORT,
    host: parsed.HOST,
    dataDir,
    dbPath: path.join(dataDir, 'netpulse.db'),
    tokenFile: path.join(dataDir, 'daemon-token'),
    webDist: WEB_DIST,
    demoMode: parsed.DEMO_DATA,
    logLevel: parsed.LOG_LEVEL,
    corsOrigins: [
      ...parsed.CORS_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      ...DESKTOP_WEBVIEW_ORIGINS,
    ],
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 3600 * 1000,
    isTest: env.VITEST === 'true',
    safeMode: parsed.NETPULSE_SAFE_MODE,
    ...overrides,
  };
  // Derive dependent paths from the FINAL dataDir — otherwise an override
  // (e.g. the desktop sidecar's app-data dir) would leave dbPath/tokenFile
  // silently pointing at the default location while dataDir reports the
  // overridden one. Explicit overrides of dbPath/tokenFile still win.
  if (!overrides || overrides.dbPath === undefined) config.dbPath = path.join(config.dataDir, 'netpulse.db');
  if (!overrides || overrides.tokenFile === undefined) config.tokenFile = path.join(config.dataDir, 'daemon-token');
  return config;
}
