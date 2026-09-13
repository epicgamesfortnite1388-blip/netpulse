import { useEffect } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

import type { AppSettings, ThemeSetting } from '@shared/models/settings';

/**
 * Theme application: reads `general.theme` (dark | light | system) from the
 * backend settings store and reflects it onto <html data-theme>. 'system'
 * follows the OS `prefers-color-scheme` and reacts live to OS theme changes.
 *
 * Mounted once in AppShell so the theme applies on every page — including
 * right after the Settings page saves (react-query cache invalidation).
 */
export function useThemeApplier(): void {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: AppSettings }>('/settings'),
    staleTime: 30_000,
    // Theme must still apply offline — cached or default — never block on it.
    retry: 1,
  });

  const theme: ThemeSetting = data?.settings?.general?.theme ?? 'dark';

  useEffect(() => {
    if (theme !== 'system') {
      document.documentElement.dataset.theme = theme;
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      document.documentElement.dataset.theme = mq.matches ? 'light' : 'dark';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // Re-apply when the settings query is invalidated after a save.
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const unsub = cache.subscribe((event) => {
      if (event.query.queryKey[0] === 'settings' && event.type === 'updated') {
        const updated = queryClient.getQueryData<{ settings: AppSettings }>(['settings']);
        const next = updated?.settings?.general?.theme;
        if (next && next !== 'system') document.documentElement.dataset.theme = next;
      }
    });
    return unsub;
  }, [queryClient]);
}
