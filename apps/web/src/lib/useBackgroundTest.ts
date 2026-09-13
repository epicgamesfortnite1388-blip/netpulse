import { useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { subscribeTest } from '@/lib/ws';

import type { WsTestMessage } from '@/lib/ws';

export interface BackgroundTestState<R> {
  /** progress 0-100 once the test is registered */
  pct: number | null;
  message: string | null;
  running: boolean;
  /** final payload delivered by test:done (WS) or the history fallback */
  result: R | null;
  error: string | null;
}

interface TestRecord {
  id: string;
  type: string;
  status: string;
  summary: Record<string, unknown> | null;
  /** Full result payload persisted with the record — the reload fallback. */
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * Track a background test: subscribe to WS progress by testId, take the final
 * payload from `test:done`, and fall back to polling the persisted test
 * record when WS delivery is missed (e.g. tab sleep or reload).
 */
export function useBackgroundTest<R>(testId: string | null): BackgroundTestState<R> {
  const [state, setState] = useState<BackgroundTestState<R>>({
    pct: null,
    message: null,
    running: testId != null,
    result: null,
    error: null,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (testId == null) return;
    let settled = false;
    let lastResult: R | null = null;

    const finish = (result: R | null, error: string | null) => {
      if (settled) return;
      settled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setState({ pct: 100, message: error ?? 'Completed', running: false, result, error });
    };

    const onMessage = (msg: WsTestMessage) => {
      if (msg.type === 'test:progress' && msg.pct != null) {
        setState((s) => ({ ...s, pct: msg.pct ?? s.pct, message: msg.message ?? s.message, running: true }));
      } else if (msg.type === 'test:error' || (msg.type === 'test:done' && msg.error != null)) {
        finish(null, (msg.message as string) ?? 'Test failed');
      } else if (msg.type === 'test:done') {
        lastResult = (msg.result as R) ?? null;
        finish(lastResult, null);
      }
    };

    const unsubscribe = subscribeTest(testId, onMessage);

    // fallback: poll the persisted record until it leaves "running". The record
    // carries the full result payload (identical to the WS test:done message),
    // so a reload or missed WS delivery still renders complete detail.
    // Consecutive-miss cap: a persisted id whose record no longer exists
    // (pruned by retention, stale after state restore) must not spin forever.
    let misses = 0;
    pollRef.current = setInterval(() => {
      void api
        .get<{ test: TestRecord | null }>(`/history/${encodeURIComponent(testId)}`)
        .then(({ test }) => {
          if (settled) return;
          if (!test) {
            misses += 1;
            if (misses >= 4) finish(null, 'Test record not found — it may have been pruned');
            return;
          }
          misses = 0;
          if (test.status === 'error') finish(null, test.error ?? 'Test failed');
          else if (test.status !== 'running') finish((test.result as R | null) ?? lastResult, null);
        })
        .catch(() => undefined);
    }, 2_500);

    return () => {
      settled = true;
      unsubscribe();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [testId]);

  return state;
}

/** Start a background test via POST and return the assigned testId. */
export async function startTest<R extends { testId: string }>(path: string, body?: unknown): Promise<string> {
  const res = await api.post<R>(path, body);
  return res.testId;
}
