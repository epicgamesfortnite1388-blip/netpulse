import type { Env } from '../src/auth';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    AUTH_SECRET: string;
    RESET_PEPPER: string;
  }
}

export {};
