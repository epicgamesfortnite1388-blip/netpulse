import { useEffect } from 'react';

import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

import type { AppSettings, TypeScaleSetting } from '@shared/models/settings';

/**
 * Type scale application: reads `general.typeScale` from the backend settings
 * store and reflects it onto <html data-type-scale>, which tokens.css maps to
 * the `--type-scale` multiplier every `--text-*` token is multiplied by.
 *
 * Mounted once in AppShell alongside the theme applier, so the preference
 * applies on every page and survives a reload — it lives in the settings store
 * rather than in `usePersistentState`, because that is sessionStorage and an
 * accessibility preference must outlive the window.
 *
 * Deliberately shaped like the theme applier: before the query resolves no
 * attribute is set, which means `--type-scale` falls back to the `:root`
 * default of 1 and the first paint is already correct — there is no flash of
 * the wrong scale on startup.
 */
export function useTypeScaleApplier(): void {
  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: AppSettings }>('/settings'),
    staleTime: 30_000,
    // A preference must still apply offline — cached or default.
    retry: 1,
  });

  // Settings rows written before this setting existed have no such field, so
  // fall back rather than trusting the backend to backfill it.
  const typeScale: TypeScaleSetting = data?.settings?.general?.typeScale ?? 'default';

  useEffect(() => {
    document.documentElement.dataset.typeScale = typeScale;
  }, [typeScale]);
}