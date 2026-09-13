import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { ScheduleStatus } from '@shared/models/settings';

import { api } from '@/lib/api';
import { subscribeTest } from '@/lib/ws';

const STATUS_TOPIC = 'schedule';

/**
 * Live recurring-benchmark status. Initial fetch + background refetch, then the
 * API pushes every state change on the `schedule` WS topic (bus replay delivers
 * the latest state to late subscribers), so the UI reflects scheduled runs as
 * they happen.
 */
export function useScheduleStatus() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['settings', 'schedule'],
    queryFn: () => api.get<{ status: ScheduleStatus }>('/settings/schedule'),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });

  useEffect(() => {
    const unsub = subscribeTest(STATUS_TOPIC, (msg) => {
      if (msg.type === 'schedule:status' && msg.result) {
        const status = (msg.result as { status?: ScheduleStatus }).status;
        if (status) {
          queryClient.setQueryData(['settings', 'schedule'], { status });
        }
      }
    });
    return unsub;
  }, [queryClient]);

  return query;
}