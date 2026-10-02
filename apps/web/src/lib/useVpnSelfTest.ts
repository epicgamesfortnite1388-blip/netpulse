import { useEffect } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { subscribeTest } from '@/lib/ws';

import type { ScheduledRunStatus, VpnSelfTestResult } from '@shared/models/settings';

export interface SelfTestPayload {
  last: VpnSelfTestResult | null;
  running: boolean;
  schedule: ScheduledRunStatus | null;
  safeMode: boolean;
}

export const VPN_SELFTEST_KEY = ['vpn', 'selftest'] as const;

/**
 * One owner for the VPN dry-run self-test state.
 *
 * Two surfaces read it — System Health (the full card) and the Dashboard's
 * "needs attention" strip — and the backend publishes every run on the
 * `vpn-selftest` WebSocket topic. Sharing the query key means react-query serves
 * both from one request, and the two surfaces can never disagree about the
 * result: there is one cache entry, not two.
 */
export function useVpnSelfTest() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: VPN_SELFTEST_KEY,
    queryFn: () => api.get<SelfTestPayload>('/vpn/selftest'),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });
  useEffect(() => {
    const unsub = subscribeTest('vpn-selftest', (msg) => {
      if (msg.type === 'vpn-selftest:done' && msg.result) {
        queryClient.setQueryData(VPN_SELFTEST_KEY, (prev: SelfTestPayload | undefined) =>
          prev ? { ...prev, last: msg.result as VpnSelfTestResult, running: false } : prev,
        );
      } else if (msg.type === 'vpn-selftest:running') {
        queryClient.setQueryData(VPN_SELFTEST_KEY, (prev: SelfTestPayload | undefined) =>
          prev ? { ...prev, running: true } : prev,
        );
      }
    });
    return unsub;
  }, [queryClient]);
  return query;
}