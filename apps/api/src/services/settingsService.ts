import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type AppSettings,
  type SettingsPatch,
} from '@netpulse/shared';

import { badRequest } from '../util/appError';

import type { SettingsRepository } from '../db/repositories';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T)) ?? base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

const STORE_KEY = 'app';

export class SettingsService {
  private cache: AppSettings | null = null;
  private onChange: ((settings: AppSettings) => void) | null = null;

  constructor(private readonly repo: SettingsRepository) {}

  /** Register a listener invoked after every successful settings update. */
  setOnChange(fn: (settings: AppSettings) => void): void {
    this.onChange = fn;
  }

  get(): AppSettings {
    if (this.cache) return this.cache;
    const stored = this.repo.get(STORE_KEY);
    const merged = stored ? deepMerge(DEFAULT_SETTINGS, stored) : DEFAULT_SETTINGS;
    const parsed = SettingsSchema.safeParse(merged);
    if (parsed.success) {
      this.cache = parsed.data as AppSettings;
      return this.cache;
    }
    // stored settings invalid (e.g. older schema) — fall back to defaults
    this.cache = DEFAULT_SETTINGS;
    return this.cache;
  }

  update(patch: SettingsPatch): AppSettings {
    const merged = deepMerge(this.get(), patch);
    const parsed = SettingsSchema.safeParse(merged);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw badRequest(
        'invalid_settings',
        first ? `${first.path.join('.')}: ${first.message}` : 'Invalid settings',
      );
    }
    this.repo.put(STORE_KEY, parsed.data as unknown as Record<string, unknown>);
    this.cache = parsed.data as AppSettings;
    this.onChange?.(this.cache);
    return this.cache;
  }
}
