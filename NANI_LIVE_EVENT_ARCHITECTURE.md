# NANI Live Event Architecture

## Transport (reuses existing systems)
- **Desktop**: Tauri native event channel `nani:event` emitted by Rust `EventBus`, plus `nani_poll_events` replay (256-entry bounded buffer) as reconnect/recovery fallback.
- **Web**: no NANI event stream is exposed over the current transport; the UI reports `event stream unavailable (web mode)` honestly. No second event system was introduced.

## Flow
```
Rust EventBus.emit(event)
  ├─ mpsc channel (internal)
  └─ app.emit('nani:event', { seq, event })
        ↓
useNaniEvents (desktop)
  ├─ listen('nani:event')  → fromTauriEvent()
  └─ poll('nani_poll_events') every 5s → fromTauriEvent()
        ↓
applyNaniEvent(state, event)
  ├─ dedupe by eventId = `${seq}:${type}`
  ├─ gap detection (seq jump)
  ├─ bounded events (200) + seen ids (512)
  └─ activity mapping (activityForEvent)
```

## Guarantees implemented
- **Dedupe**: `eventId` in a bounded seen-set; replay overlap is harmless.
- **Ordering**: events appended; `lastSeq` tracked; out-of-order delivery is retained and not lost.
- **Gaps**: forward jumps counted in `gapCount`; the poll recovers retained events.
- **Reconnect/restart**: listener re-attach on mount + replay poll; buffer empty after restart (Rust restarts with seq 0), so `joinedLate` is informational.
- **Bounded memory**: 200 events / 512 ids; oldest dropped.
- **Cleanup**: `useEffect` return removes the Tauri listener and clears timers; `cancelled` guard prevents late state writes.

## Limitations
- The web API's `RealtimeBus` events are not yet bridged into this hook (no client subscription over the current WS test stream for NANI topics).
- Rust `Event` currently has no explicit investigation-session lifecycle variants (`InvestigationStarted`, etc.); the UI maps the existing event kinds truthfully and does not fabricate the missing ones.
