import { transport, initTransport } from '@/lib/transport';
import { api } from '@/lib/api';

export interface WsTestMessage {
  type: string;
  testId?: string;
  task?: string;
  pct?: number;
  message?: string;
  result?: unknown;
  error?: unknown;
  observation?: unknown;
  targetId?: string;
  observationId?: string;
  sweepId?: string;
}

/**
 * Subscribe to live progress for a running test. Returns an unsubscribe fn.
 *
 * The socket URL comes from the transport layer: desktop mode connects to the
 * loopback sidecar. The WS upgrade authenticates with a single-use 30 s
 * ticket minted via the authenticated REST surface (see below) — progress
 * frames carry no privileged data, but the endpoint is still ticket-gated.
 */
export function subscribeTest(
  testId: string,
  onMessage: (msg: WsTestMessage) => void,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let cancelled = false;

  void (async () => {
    await initTransport();
    if (cancelled) return;
    const t = transport();
    try {
      // The WS route requires a single-use ticket (the session cookie is
      // SameSite=strict and browsers cannot attach Authorization headers to
      // WebSocket handshakes). Mint one via the authenticated API first.
      const { ticket } = await api.post<{ ticket: string; expiresInMs: number }>('/ws/ticket');
      ws = new WebSocket(`${t.wsBase}/api/v1/ws?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      return;
    }

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: 'subscribe', testId }));
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data as string) as WsTestMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onerror = () => {
      // progress is best-effort; the POST response carries the final result
    };
  })();

  return () => {
    if (closed) return;
    closed = true;
    cancelled = true;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  };
}

import { useEffect } from 'react';

/** React hook: subscribe to live progress for a test while testId is set. */
export function useWsTestProgress(
  testId: string | null,
  onMessage: (msg: WsTestMessage) => void,
): void {
  useEffect(() => {
    if (!testId) return;
    // The test republishes its full result on completion, so resubscribing only
    // when testId changes is sufficient for correctness of the final result.
    const unsub = subscribeTest(testId, onMessage);
    return unsub;
  }, [testId, onMessage]);
}
