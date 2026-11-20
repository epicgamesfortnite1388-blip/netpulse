/**
 * NANI live event contracts + a pure, testable reducer.
 *
 * Two real event sources exist and are normalized here:
 *
 *  1. Desktop — Rust `EventBus` emits a Tauri event on channel `nani:event`
 *     shaped `{ seq, event: { kind, payload } }`, and keeps a 256-entry replay
 *     buffer readable through the `nani_poll_events` command.
 *  2. Web — the API's `RealtimeBus` publishes `{ seq, at, type, payload,
 *     version }` envelopes on `nani:*` topics (consumed over the existing
 *     websocket test stream where available).
 *
 * Nothing here invents events. The reducer only orders, deduplicates and maps
 * real events to an activity state. Unknown event kinds are retained verbatim
 * and never fabricate measurements.
 */

export type NaniActivityState =
  | 'Idle'
  | 'Listening'
  | 'Planning'
  | 'Observing'
  | 'Investigating'
  | 'Testing'
  | 'Analyzing'
  | 'Comparing'
  | 'Verifying'
  | 'Learning'
  | 'Waiting'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export interface NaniEvent {
  /** Stable identity for dedupe: `${seq}:${type}`. */
  eventId: string;
  /** Monotonic sequence from the emitting bus. */
  seq: number;
  /** Wall-clock time in ms (0 when the source did not supply one). */
  at: number;
  /** Rust variant name (e.g. "FailureDetected") or bus topic (e.g. "nani:diagnosis:completed"). */
  type: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
}

export interface NaniEventState {
  /** Highest sequence seen so far. */
  lastSeq: number;
  /** Count of detected sequence gaps (missing events we could not recover). */
  gapCount: number;
  /** Whether the first event observed started above 1 (we joined late). */
  joinedLate: boolean;
  /** Bounded list of most-recent events (oldest first). */
  events: NaniEvent[];
  /** Bounded set of recent eventIds, for dedupe. */
  seenIds: string[];
  /** Latest activity state derived from the most recent real event. */
  activity: NaniActivityState;
  /** Last activity description that maps to a real event. */
  detail: string | null;
}

export const MAX_EVENTS = 200;
export const MAX_SEEN = 512;

export function emptyEventState(): NaniEventState {
  return {
    lastSeq: 0,
    gapCount: 0,
    joinedLate: false,
    events: [],
    seenIds: [],
    activity: 'Idle',
    detail: null,
  };
}

/** Why NANI has no measurements to show, taken from a real event. */
export interface MeasurementGapSignal {
  /** Wall-clock time of the failing event (0 when the source reported none). */
  at: number;
  /** Truthful description of the failure, from the event payload. */
  label: string;
  /** The API or subsystem the failure was attributed to, when reported. */
  subject: string | null;
}

/**
 * True only for an explicit failure/unknown health verdict. A missing field is
 * NOT unhealthy — it simply carries no negative information.
 */
function isUnhealthyVerdict(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /unhealthy|failed|unknown/i.test(value);
}

/** NANI-021: a health event that names an upstream route is not a direct measurement. */
function isInferredProxyRoute(payload: Record<string, unknown>): boolean {
  const route = payload.route;
  return typeof route === 'string' && route.startsWith('upstream:');
}

/**
 * The most recent record of a health check that failed before measuring, or
 * `null` when no such failure is the current explanation.
 *
 * Scans backwards from the newest event: a later health or telemetry event
 * means observation resumed, so an older breaker trip no longer explains an
 * empty view. This only reads events that actually happened — it never guesses
 * that a check failed because the list is empty.
 */
export function lastFailedHealthSignal(events: NaniEvent[]): MeasurementGapSignal | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (
      event.type === 'CircuitBreakerTripped' ||
      event.type === 'RecoveryRolledBack' ||
      event.type === 'nani:recovery:rolledback' ||
      event.type === 'nani:recovery:exhausted'
    ) {
      const subject =
        typeof event.payload.api_id === 'string'
          ? event.payload.api_id
          : typeof event.payload.apiId === 'string'
            ? event.payload.apiId
            : null;
      return { at: event.at, label: describeEvent(event.type, event.payload), subject };
    }
    if (event.type === 'TelemetryTick' || event.type === 'nani:health:updated' ||
        event.type === 'CircuitBreakerRecovered' ||
        (event.type === 'ApiHealthChanged' && !isUnhealthyVerdict(event.payload.health)) ||
        // F-09: only a healthy/degraded check means observation resumed. An
        // Unhealthy/Unknown verdict must not erase an older failure reason.
        (event.type === 'HealthCheckCompleted' && !isUnhealthyVerdict(event.payload.health) && !isInferredProxyRoute(event.payload))) {
      return null;
    }
    // An explicit unhealthy/unknown verdict IS itself a measurement gap:
    // surface it instead of hiding the older failure reason.
    if ((event.type === 'HealthCheckCompleted' || event.type === 'ApiHealthChanged') &&
        (isUnhealthyVerdict(event.payload.health) || isInferredProxyRoute(event.payload))) {
      const subject =
        typeof event.payload.api_id === 'string'
          ? event.payload.api_id
          : typeof event.payload.apiId === 'string'
            ? event.payload.apiId
            : null;
      return { at: event.at, label: describeEvent(event.type, event.payload), subject };
    }
  }
  return null;
}

/** Map a real backend event to an activity state. Unknown -> keep previous. */
export function activityForEvent(type: string): NaniActivityState | null {
  switch (type) {
    case 'TelemetryTick':
    case 'HealthCheckCompleted':
    case 'nani:health:updated':
      return 'Observing';
    case 'FailureDetected':
    case 'nani:diagnosis:completed':
      return 'Analyzing';
    case 'ApiHealthChanged':
      return 'Verifying';
    case 'DiagnosisUpdated':
      return 'Comparing';
    case 'DriftDetected':
      return 'Analyzing';
    case 'RecoveryStarted':
    case 'nani:recovery:planned':
      return 'Planning';
    case 'RecoveryStepCompleted':
      return 'Testing';
    case 'RecoveryCompleted':
      return 'Completed';
    case 'RecoveryRolledBack':
    case 'nani:recovery:rolledback':
      return 'Failed';
    case 'RouteSelected':
    case 'nani:route:activated':
      return 'Verifying';
    case 'CircuitBreakerTripped':
      return 'Failed';
    case 'CircuitBreakerRecovered':
      return 'Completed';
    case 'InvestigationStarted':
      return 'Investigating';
    case 'InvestigationStageStarted':
    case 'InvestigationStageCompleted':
      return 'Investigating';
    case 'ProbeStarted':
    case 'ProbeCompleted':
      return 'Testing';
    case 'ObservationCreated':
    case 'EvidenceAdded':
      return 'Observing';
    case 'HypothesisCreated':
    case 'HypothesisUpdated':
      return 'Comparing';
    case 'AnalysisCompleted':
      return 'Analyzing';
    case 'VerificationCompleted':
      return 'Verifying';
    case 'InvestigationCompleted':
      return 'Completed';
    case 'InvestigationFailed':
      return 'Failed';
    case 'InvestigationCancelled':
      return 'Cancelled';
    case 'InvestigationUpdated':
      return null;
    case 'LearningUpdate':
      return 'Learning';
    case 'UserAction':
      return 'Completed';
    default:
      // HTTP recovery step topics carry the outcome in the suffix.
      if (type.startsWith('nani:recovery:step:')) return 'Testing';
      if (type === 'nani:recovery:exhausted') return 'Failed';
      if (type === 'nani:recovery:reset') return 'Idle';
      return null;
  }
}

/** A short, truthful description of what a real event means. */
export function describeEvent(type: string, payload: Record<string, unknown>): string {
  const api = typeof payload.api_id === 'string' ? payload.api_id : typeof payload.apiId === 'string' ? payload.apiId : null;
  switch (type) {
    case 'TelemetryTick':
      return 'Telemetry snapshot received';
    case 'HealthCheckCompleted': {
      const route = typeof payload.route === 'string' && payload.route.length > 0
        ? ` via ${payload.route} (not a direct measurement)`
        : '';
      return `Health check ${payload.health ? String(payload.health) : 'finished'}${api ? ` for ${api}` : ''}${route}`;
    }
    case 'FailureDetected':
      return `Failure classified${payload.category ? `: ${String(payload.category)}` : ''}${api ? ` (${api})` : ''}`;
    case 'ApiHealthChanged':
      return `API health changed${api ? ` for ${api}` : ''}`;
    case 'DiagnosisUpdated':
    case 'nani:diagnosis:completed':
      return `Diagnosis updated${payload.top ? `: ${String(payload.top)}` : ''}`;
    case 'DriftDetected':
      return `Drift detected${payload.metric ? ` in ${String(payload.metric)}` : ''}`;
    case 'RecoveryStarted':
    case 'nani:recovery:planned':
      return 'Recovery planned';
    case 'RecoveryStepCompleted':
    case 'nani:recovery:step:succeeded':
    case 'nani:recovery:step:failed':
      return `Recovery step ${payload.stepId ? String(payload.stepId) : ''}`.trim();
    case 'RecoveryCompleted':
      return `Recovery ${payload.success === false ? 'exhausted' : 'completed'}`;
    case 'RecoveryRolledBack':
    case 'nani:recovery:rolledback':
      return `Recovery rolled back${payload.route_id || payload.routeId ? ` to ${String(payload.route_id ?? payload.routeId)}` : ''} (state only; no route was reconfigured)`;
    case 'nani:recovery:reset':
      return `Recovery plan cleared${payload.recoveryId ? ` (${String(payload.recoveryId)})` : ''}; learned evidence retained`;
    case 'RouteSelected':
    case 'nani:route:activated':
      return `Route selected${payload.route_id || payload.routeId ? `: ${String(payload.route_id ?? payload.routeId)}` : ''}`;
    case 'CircuitBreakerTripped':
      return `Circuit breaker tripped${api ? ` (${api})` : ''}`;
    case 'CircuitBreakerRecovered':
      return `Circuit breaker recovered${api ? ` (${api})` : ''}`;
    case 'InvestigationStarted':
      return `Investigation started${payload.query ? `: ${String(payload.query)}` : ''}`;
    case 'InvestigationStageStarted':
      return `Stage started${payload.stage ? `: ${String(payload.stage)}` : ''}`;
    case 'InvestigationStageCompleted':
      return `Stage ${payload.stage ?? ''} ${payload.ok === false ? 'failed' : 'completed'}`.trim();
    case 'ProbeStarted':
      return `Probe started${api ? ` for ${api}` : ''}${payload.layer ? ` [${String(payload.layer)}]` : ''}`;
    case 'ProbeCompleted':
      return `Probe ${payload.ok === false ? 'failed' : 'completed'}${api ? ` (${api})` : ''}`;
    case 'ObservationCreated':
      return `Observation${api ? ` for ${api}` : ''}${payload.layer ? ` [${String(payload.layer)}]` : ''}`;
    case 'EvidenceAdded':
      return `Evidence added${payload.evidence_id ? ` (${String(payload.evidence_id)})` : ''}`;
    case 'HypothesisCreated':
    case 'HypothesisUpdated':
      return `Hypothesis${payload.hypothesis ? `: ${String(payload.hypothesis)}` : ''} (confidence ${payload.confidence ?? 0})`;
    case 'AnalysisCompleted':
      return `Analysis complete${payload.top_hypothesis ? `: ${String(payload.top_hypothesis)}` : ''} (confidence ${payload.confidence ?? 0})`;
    case 'VerificationCompleted':
      // F-08: an absent `verified` field is NOT a pass. Default to unknown so
      // an unavailable verification can never be rendered as a success.
      return `Verification ${
        payload.verified === true ? 'passed' : payload.verified === false ? 'failed' : 'unavailable'
      }${payload.route_id ? ` via ${String(payload.route_id)}` : ''}`;
    case 'InvestigationCompleted':
      return `Investigation completed${payload.result ? `: ${String(payload.result)}` : ''}`;
    case 'InvestigationFailed':
      return `Investigation failed${payload.reason ? `: ${String(payload.reason)}` : ''}`;
    case 'InvestigationCancelled':
      return `Investigation cancelled${payload.reason ? `: ${String(payload.reason)}` : ''}`;
    case 'InvestigationUpdated':
      return `Investigation updated${payload.detail ? `: ${String(payload.detail)}` : ''}`;
    case 'LearningUpdate':
      return `Learning updated${payload.metric ? `: ${String(payload.metric)}` : ''}`;
    case 'nani:health:updated':
      return `Health check${api ? ` for ${api}` : ''}: ${String(payload.status ?? 'updated')}`;
    default:
      return type;
  }
}

/** Normalize the desktop Tauri payload `{ seq, event: { kind, payload } }`. */
export function fromTauriEvent(raw: unknown): NaniEvent | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const event = r.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object') return null;
  const kind = typeof event.kind === 'string' ? event.kind : null;
  if (!kind) return null;
  const payload =
    event.payload != null && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  const seq = typeof r.seq === 'number' ? r.seq : 0;
  return {
    eventId: `${seq}:${kind}`,
    seq,
    at: typeof payload.at === 'number' ? payload.at : 0,
    type: kind,
    payload,
    schemaVersion: 1,
  };
}

/** Normalize the web bus envelope `{ seq, at, type, payload, version }`. */
export function fromBusEvent(raw: unknown): NaniEvent | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : null;
  if (!type) return null;
  const payload =
    r.payload != null && typeof r.payload === 'object'
      ? (r.payload as Record<string, unknown>)
      : {};
  const seq = typeof r.seq === 'number' ? r.seq : 0;
  return {
    eventId: `${seq}:${type}`,
    seq,
    at: typeof r.at === 'number' ? r.at : 0,
    type,
    payload,
    schemaVersion: typeof r.version === 'number' ? r.version : 1,
  };
}

/**
 * Apply one real event. Duplicates and stale sequences are ignored; a forward
 * jump is counted as a gap but still applied (events are not lost locally,
 * only ordered). Bounded buffers prevent unbounded growth.
 */
export function applyNaniEvent(state: NaniEventState, event: NaniEvent): NaniEventState {
  if (state.seenIds.includes(event.eventId)) return state;

  let gapCount = state.gapCount;
  let joinedLate = state.joinedLate;
  if (state.lastSeq === 0 && event.seq > 1) joinedLate = true;
  if (state.lastSeq > 0 && event.seq > state.lastSeq + 1) {
    gapCount += event.seq - state.lastSeq - 1;
  }

  const events = [...state.events, event];
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  const seenIds = [...state.seenIds, event.eventId];
  if (seenIds.length > MAX_SEEN) seenIds.splice(0, seenIds.length - MAX_SEEN);

  const mapped = activityForEvent(event.type);

  return {
    lastSeq: Math.max(state.lastSeq, event.seq),
    gapCount,
    joinedLate,
    events,
    seenIds,
    activity: mapped ?? state.activity,
    detail: describeEvent(event.type, event.payload),
  };
}

/** Apply many events in order (e.g. a replay buffer after reconnect). */
export function applyNaniEvents(state: NaniEventState, events: NaniEvent[]): NaniEventState {
  return events.reduce(applyNaniEvent, state);
}

/**
 * Record a replay gap the BACKEND reported (event ring evicted / bus restarted).
 * `applyNaniEvent` only detects gaps between sequences it can see; when the
 * backend says "you missed events", that signal must still reach the UI's
 * `Gaps` metric instead of being silently dropped (F-07).
 */
export function recordReplayGap(state: NaniEventState): NaniEventState {
  return {
    ...state,
    gapCount: state.gapCount + 1,
    joinedLate: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Investigation-derived views (read-only, event-sourced)            */
/* ------------------------------------------------------------------ */

/** Id of the most recently started investigation, if any. */
export function currentInvestigationId(state: NaniEventState): string | null {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const e = state.events[i]!;
    if (e.type === 'InvestigationStarted') {
      const id = e.payload.investigation_id;
      return typeof id === 'string' ? id : null;
    }
  }
  return null;
}

/** Current stage of the most recent investigation, cleared on a terminal event. */
export function currentInvestigationStage(state: NaniEventState): string | null {
  let stage: string | null = null;
  let terminal = false;
  for (const e of state.events) {
    switch (e.type) {
      case 'InvestigationStageStarted':
        stage = typeof e.payload.stage === 'string' ? e.payload.stage : null;
        terminal = false;
        break;
      case 'InvestigationCompleted':
      case 'InvestigationFailed':
      case 'InvestigationCancelled':
        terminal = true;
        break;
      default:
        break;
    }
  }
  return terminal ? null : stage;
}

/** Observations recorded for an investigation (most recent first). */
export function investigationObservations(
  state: NaniEventState,
  investigationId: string,
): NaniEvent[] {
  return state.events
    .filter((e) => e.type === 'ObservationCreated' && e.payload.investigation_id === investigationId)
    .slice()
    .reverse();
}

/** Hypotheses emitted for an investigation (most recent first, deduped by id keeping latest). */
export function investigationHypotheses(
  state: NaniEventState,
  investigationId: string,
): Array<{ id: string; hypothesis: string; confidence: number }> {
  const byId = new Map<string, { id: string; hypothesis: string; confidence: number }>();
  for (const e of state.events) {
    if (
      (e.type === 'HypothesisCreated' || e.type === 'HypothesisUpdated') &&
      e.payload.investigation_id === investigationId
    ) {
      const id = e.payload.hypothesis_id;
      const hypothesis = e.payload.hypothesis;
      const confidence = e.payload.confidence;
      if (typeof id === 'string' && typeof hypothesis === 'string' && typeof confidence === 'number') {
        byId.set(id, { id, hypothesis, confidence });
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.confidence - a.confidence);
}

/** Terminal outcome of the most recent investigation, if any. */
export function investigationOutcome(state: NaniEventState): {
  id: string | null;
  kind: 'completed' | 'failed' | 'cancelled' | null;
  detail: string | null;
} | null {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const e = state.events[i]!;
    if (e.type === 'InvestigationCompleted') {
      return {
        id: String(e.payload.investigation_id),
        kind: 'completed',
        detail: typeof e.payload.result === 'string' ? e.payload.result : null,
      };
    }
    if (e.type === 'InvestigationFailed') {
      return {
        id: String(e.payload.investigation_id),
        kind: 'failed',
        detail: typeof e.payload.reason === 'string' ? e.payload.reason : null,
      };
    }
    if (e.type === 'InvestigationCancelled') {
      return {
        id: String(e.payload.investigation_id),
        kind: 'cancelled',
        detail: typeof e.payload.reason === 'string' ? e.payload.reason : null,
      };
    }
  }
  return null;
}
