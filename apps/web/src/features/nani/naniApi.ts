/**
 * Typed frontend API for NANI.
 *
 * In the packaged desktop app the authoritative engine is the Rust core,
 * exposed through Tauri commands (`nani_status`, `nani_health_check_all`,
 * `nani_explain`, `nani_learning_status`, `nani_poll_events`). In web mode the
 * same capabilities are served by the API's `/nani/*` routes over the existing
 * transport. Every call is a real backend call; there is no mock path.
 */
import { api } from '@/lib/api';
import { hasTauriIpc, tauriInvoke } from '@/lib/transport';

export interface NaniStatusDto {
  seq: number;
  healthy_apis: number;
  total_apis: number;
  recovery_active: boolean;
  drift_detected: boolean;
}

export interface NaniWebStatusDto {
  enabled: boolean;
  intelligenceLevel: string;
  lastDiagnosis: { cause?: string; confidence?: string; latencyMs?: number } | null;
}

export interface NaniExplainDto {
  deterministic: string;
  narrative: string | null;
  source: 'deterministic' | 'local_model';
  grounded: boolean;
  warning: string | null;
}

export interface NaniLearningStatusDto {
  measurements_accepted: number;
  measurements_rejected: number;
  profiles: number;
  global_reliability: number;
  drift_events: number;
  episodes: number;
}

/** Snapshot of an investigation (active or historical), mirroring the Rust `InvestigationStatus`. */
export interface InvestigationStatusDto {
  id: string;
  query: string;
  stage: string;
  outcome: string | null;
  seq: number;
  started_at: number;
  updated_at: number;
  observation_count: number;
  hypothesis_count: number;
  top_hypothesis: string | null;
  confidence: number;
  result: string;
  error: string | null;
}

export function isDesktopNani(): boolean {
  return hasTauriIpc();
}

/** One hypothesis with the probability it started from and holds now. */
export interface HypothesisProbabilityDto {
  label: string;
  prior: number;
  posterior: number;
}

/** The diagnostic probe the engine would run next, with its expected gain. */
export interface ProbeSelectionDto {
  test_name: string;
  expected_information_gain: number;
  cost: number;
}

export interface HypothesisViewDto {
  hypotheses: HypothesisProbabilityDto[];
  entropy_nats: number;
  map_label: string | null;
  /**
   * `map_label`'s posterior after the isotonic map fitted on recorded outcomes.
   * null when no map is fitted, so it doubles as the "is this calibrated" flag.
   */
  map_confidence_calibrated: number | null;
  /** Real probe outcomes behind that map (0 = nothing recorded yet). */
  calibration_samples: number;
  selected_probe: ProbeSelectionDto | null;
}

/**
 * The Rust diagnostic engine's hypothesis space. Desktop only — in web mode
 * there is no authoritative engine instance, so this returns null rather than
 * synthesizing priors or gains.
 */
export async function fetchHypothesisView(): Promise<HypothesisViewDto | null> {
  const invoke = tauriInvoke<HypothesisViewDto>('nani_math_hypothesis_view');
  if (invoke) return invoke;
  return null;
}

export async function fetchNaniStatus(): Promise<{ desktop: NaniStatusDto | null; web: NaniWebStatusDto | null }> {
  const invoke = tauriInvoke<NaniStatusDto>('nani_status');
  if (invoke) {
    return { desktop: await invoke, web: null };
  }
  const web = await api.get<NaniWebStatusDto>('/nani/status');
  return { desktop: null, web };
}

export async function fetchLearningStatus(): Promise<NaniLearningStatusDto | null> {
  const invoke = tauriInvoke<NaniLearningStatusDto>('nani_learning_status');
  if (invoke) return invoke;
  return null;
}

export async function fetchDriftEvents(): Promise<Array<Record<string, unknown>>> {
  const invoke = tauriInvoke<Array<Record<string, unknown>>>('nani_learning_drift');
  if (invoke) return invoke;
  return [];
}

/**
 * Run a health check. Desktop delegates to the Rust registry; web iterates
 * registered APIs through the real `/nani/check` route.
 */
export async function runHealthCheck(): Promise<{ desktop: string | null; webChecked: number }> {
  const invoke = tauriInvoke<string>('nani_health_check_all');
  if (invoke) {
    return { desktop: await invoke, webChecked: 0 };
  }
  const { apis } = await api.get<{ apis: Array<{ entry: { id: string; endpoint: string } }> }>(
    '/nani/apis',
  );
  let checked = 0;
  for (const a of apis) {
    await api.post('/nani/check', { apiId: a.entry.id, target: a.entry.endpoint });
    checked += 1;
  }
  return { desktop: null, webChecked: checked };
}

/**
 * Ask NANI to explain its current state. Desktop uses the Rust explanation
 * (deterministic facts, optional local model rewrite). Web falls back to a
 * real diagnosis with no observations, which honestly reports insufficient
 * evidence rather than inventing one.
 */
export async function explain(question: string): Promise<{ text: string; source: string; warning: string | null }> {
  const invoke = tauriInvoke<NaniExplainDto>('nani_explain', { question });
  if (invoke) {
    const res = await invoke;
    const text = [res.deterministic, res.narrative].filter(Boolean).join('\n\n');
    return { text, source: res.source, warning: res.warning };
  }
  const res = await api.post<{
    insufficientEvidence: boolean;
    explanation: string;
    top: string | null;
    confidence: number;
    recommendedTest: string | null;
  }>('/nani/diagnose', { target: 'local', observations: [] });
  const text = res.insufficientEvidence
    ? `Insufficient evidence to diagnose. ${res.recommendedTest ? `Recommended next test: ${res.recommendedTest}.` : ''}`
    : res.explanation;
  return { text, source: 'deterministic', warning: null };
}

/** One catch-up slice of the desktop replay buffer. */
export interface EventReplaySliceDto {
  latest_seq: number;
  oldest_seq: number;
  /** `since` could not be honoured; `events` holds the whole retained buffer. */
  gap: boolean;
  /** `{ seq, event }` envelopes, oldest first — same shape as the live channel. */
  events: unknown[];
}

/**
 * Poll the desktop replay buffer.
 *
 * Pass `since` (the last sequence already applied) for incremental catch-up.
 * Omitting it asks for a full bounded replay, which is only needed before a
 * sequence is known. Web mode has no replay buffer and reports an empty slice.
 */
export async function pollEvents(since?: number): Promise<EventReplaySliceDto> {
  const invoke = tauriInvoke<EventReplaySliceDto>(
    'nani_poll_events',
    since === undefined ? {} : { since },
  );
  if (invoke) return invoke;
  return { latest_seq: 0, oldest_seq: 0, gap: false, events: [] };
}

/* ------------------------------------------------------------------ */
/*  Investigation lifecycle (desktop Tauri commands)                  */
/* ------------------------------------------------------------------ */

/** Start a new investigation. Returns the investigation id. Desktop only. */
export async function startInvestigation(query: string): Promise<string> {
  const invoke = tauriInvoke<string>('nani_start_investigation', { query });
  if (invoke) return invoke;
  throw new Error('investigation start is desktop-only');
}

/** Cancel an in-flight investigation by id. Desktop only. */
export async function cancelInvestigation(investigationId: string): Promise<boolean> {
  const invoke = tauriInvoke<boolean>('nani_cancel_investigation', {
    investigation_id: investigationId,
  });
  if (invoke) return invoke;
  throw new Error('investigation cancel is desktop-only');
}

/** Status snapshot for one investigation (active or historical). Desktop only. */
export async function fetchInvestigationStatus(
  investigationId: string,
): Promise<InvestigationStatusDto | null> {
  const invoke = tauriInvoke<InvestigationStatusDto | null>('nani_investigation_status', {
    investigation_id: investigationId,
  });
  if (invoke) return invoke;
  throw new Error('investigation status is desktop-only');
}

/** List all investigations (active + history), most recent first. Desktop only. */
export async function listInvestigations(): Promise<InvestigationStatusDto[]> {
  const invoke = tauriInvoke<InvestigationStatusDto[]>('nani_investigations');
  if (invoke) return invoke;
  throw new Error('investigation list is desktop-only');
}
