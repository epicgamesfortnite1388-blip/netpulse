import type { Env } from '../src/auth';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    AUTH_SECRET: string;
    RESET_PEPPER: string;
    NETPULSE_SERVICE_SECRET: string;
    TELEGRAM_BOT_BASE_URL: string;
    OPS_TOKEN: string;
  }
}

export {};
