import { useEffect, useRef, useState } from 'react';

import { hasTauriIpc } from '@/lib/transport';

import { pollEvents } from './naniApi';
import {
  applyNaniEvents,
  emptyEventState,
  fromBusEvent,
  fromTauriEvent,
  type NaniEvent,
  type NaniEventState,
} from './naniEvents';

type TauriListen = (
  event: string,
  handler: (e: { payload: unknown }) => void,
) => Promise<() => void>;

function resolveListen(): TauriListen | null {
  const w = window as unknown as {
    __TAURI__?: { event?: { listen?: TauriListen } };
  };
  return w.__TAURI__?.event?.listen ?? null;
}

const POLL_MS = 5_000;

/**
 * Subscribe to real NANI events.
 *
 * Desktop: a Tauri listener on `nani:event` for live delivery, plus an
 * incremental `nani_poll_events(since)` catch-up poll every few seconds. The
 * poll sends the last sequence it applied and receives only newer events, so a
 * quiet system costs an empty slice instead of a 256-event replay. When the bus
 * reports a gap (evicted events or a restart) it returns the whole buffer and
 * the reducer rebuilds from it without duplicating anything.
 *
 * Web: the HTTP bus does not expose a NANI event stream over the current
 * transport, so this returns `available: false` and no events — an honest
 * "unavailable" state rather than simulated activity.
 */
export function useNaniEvents(): { state: NaniEventState; available: boolean } {
  const [state, setState] = useState<NaniEventState>(() => emptyEventState());
  const visible = hasTauriIpc();
  const unlistenRef = useRef<(() => void) | null>(null);
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([]);
  /** Highest sequence applied so far — the cursor sent to `nani_poll_events`. */
  const lastSeqRef = useRef(0);

  useEffect(() => {
    lastSeqRef.current = state.lastSeq;
  }, [state.lastSeq]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const listen = resolveListen();

    const ingestRaw = (raws: unknown[]) => {
      if (cancelled) return;
      const parsed = raws.map((r) => fromTauriEvent(r) ?? fromBusEvent(r)).filter((e): e is NaniEvent => e != null);
      if (parsed.length === 0) return;
      setState((prev) => applyNaniEvents(prev, parsed));
    };

    const attach = async () => {
      if (listen) {
        try {
          const unlisten = await listen('nani:event', (e) => ingestRaw([e.payload]));
          if (cancelled) {
            unlisten();
          } else {
            unlistenRef.current = unlisten;
          }
        } catch {
          // Listener unavailable: the poll below still recovers state.
        }
      }

      // Recover what the listener missed, then keep polling incrementally.
      const poll = async () => {
        try {
          const since = lastSeqRef.current;
          const slice = await pollEvents(since > 0 ? since : undefined);
          if (slice.events.length > 0) ingestRaw(slice.events);
        } catch {
          // Backend restarting; the next tick retries from the same cursor.
        }
      };
      await poll();
      const timer = setInterval(() => void poll(), POLL_MS);
      timersRef.current.push(timer);
    };

    void attach();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
      for (const t of timersRef.current) clearInterval(t);
      timersRef.current = [];
    };
  }, [visible]);

  return { state, available: visible };
}
