import { describe, expect, it } from 'vitest';

import {
  activityForEvent,
  applyNaniEvent,
  applyNaniEvents,
  currentInvestigationId,
  currentInvestigationStage,
  describeEvent,
  emptyEventState,
  fromBusEvent,
  fromTauriEvent,
  investigationHypotheses,
  investigationObservations,
  investigationOutcome,
  lastFailedHealthSignal,
  MAX_EVENTS,
  type NaniEvent,
} from './naniEvents';

function ev(seq: number, type: string, payload: Record<string, unknown> = {}): NaniEvent {
  return { eventId: `${seq}:${type}`, seq, at: seq, type, payload, schemaVersion: 1 };
}

describe('NANI event normalization', () => {
  it('normalizes a Tauri event envelope', () => {
    const e = fromTauriEvent({ seq: 4, event: { kind: 'FailureDetected', payload: { category: 'tls' } } });
    expect(e).not.toBeNull();
    expect(e?.type).toBe('FailureDetected');
    expect(e?.seq).toBe(4);
    expect(e?.eventId).toBe('4:FailureDetected');
    expect(e?.payload.category).toBe('tls');
  });

  it('rejects malformed Tauri payloads', () => {
    expect(fromTauriEvent(null)).toBeNull();
    expect(fromTauriEvent({ seq: 1 })).toBeNull();
    expect(fromTauriEvent({ seq: 1, event: {} })).toBeNull();
  });

  it('normalizes a bus envelope and maps snake_case fields', () => {
    const e = fromBusEvent({ seq: 9, at: 123, type: 'nani:diagnosis:completed', payload: { top: 'dns' }, version: 1 });
    expect(e?.eventId).toBe('9:nani:diagnosis:completed');
    expect(e?.at).toBe(123);
    expect(e?.payload.top).toBe('dns');
  });
});

describe('NANI event reducer', () => {
  it('deduplicates events by eventId', () => {
    let s = emptyEventState();
    s = applyNaniEvent(s, ev(1, 'TelemetryTick'));
    s = applyNaniEvent(s, ev(1, 'TelemetryTick'));
    expect(s.events).toHaveLength(1);
    expect(s.seenIds).toHaveLength(1);
  });

  it('detects forward sequence gaps', () => {
    let s = emptyEventState();
    s = applyNaniEvent(s, ev(1, 'TelemetryTick'));
    s = applyNaniEvent(s, ev(5, 'TelemetryTick'));
    expect(s.gapCount).toBe(3);
    expect(s.lastSeq).toBe(5);
  });

  it('applies an incremental catch-up slice without duplicating seen events', () => {
    let s = applyNaniEvents(emptyEventState(), [ev(1, 'TelemetryTick'), ev(2, 'TelemetryTick')]);
    // The poll asked for everything after 2; the bus re-sent 1-2 as well.
    const slice = [
      fromTauriEvent({ seq: 1, event: { kind: 'TelemetryTick', payload: {} } }),
      fromTauriEvent({ seq: 2, event: { kind: 'TelemetryTick', payload: {} } }),
      fromTauriEvent({ seq: 3, event: { kind: 'FailureDetected', payload: { category: 'tls' } } }),
    ].filter((e): e is NaniEvent => e != null);

    s = applyNaniEvents(s, slice);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.lastSeq).toBe(3);
    expect(s.gapCount).toBe(0);
    expect(s.activity).toBe('Analyzing');
  });

  it('counts the missed events when a catch-up slice starts past a gap', () => {
    // Bus state: sequences 1..10, but only 6..10 survived the bounded buffer.
    let s = applyNaniEvents(emptyEventState(), [ev(1, 'TelemetryTick')]);
    s = applyNaniEvents(s, [ev(6, 'TelemetryTick'), ev(7, 'TelemetryTick')]);
    expect(s.lastSeq).toBe(7);
    expect(s.gapCount).toBe(4);
    expect(s.events.map((e) => e.seq)).toEqual([1, 6, 7]);
  });

  it('marks a late join when the first sequence is above one', () => {
    let s = emptyEventState();
    s = applyNaniEvent(s, ev(7, 'TelemetryTick'));
    expect(s.joinedLate).toBe(true);
  });

  it('keeps ordering while accepting out-of-order delivery', () => {
    let s = emptyEventState();
    s = applyNaniEvents(s, [ev(1, 'TelemetryTick'), ev(3, 'TelemetryTick'), ev(2, 'TelemetryTick')]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 3, 2]);
    expect(s.lastSeq).toBe(3);
  });

  it('bounds the retained event buffer', () => {
    let s = emptyEventState();
    for (let i = 1; i <= MAX_EVENTS + 50; i += 1) {
      s = applyNaniEvent(s, ev(i, 'TelemetryTick'));
    }
    expect(s.events.length).toBe(MAX_EVENTS);
    expect(s.events[s.events.length - 1]?.seq).toBe(MAX_EVENTS + 50);
  });

  it('maps real event kinds to activity states', () => {
    expect(activityForEvent('TelemetryTick')).toBe('Observing');
    expect(activityForEvent('FailureDetected')).toBe('Analyzing');
    expect(activityForEvent('RecoveryStarted')).toBe('Planning');
    expect(activityForEvent('RecoveryStepCompleted')).toBe('Testing');
    expect(activityForEvent('LearningUpdate')).toBe('Learning');
    expect(activityForEvent('nani:recovery:step:succeeded')).toBe('Testing');
    expect(activityForEvent('nani:recovery:exhausted')).toBe('Failed');
    expect(activityForEvent('unknown:kind')).toBeNull();
  });

  it('never fabricates an unknown event into an activity change', () => {
    let s = emptyEventState();
    s = applyNaniEvent(s, ev(1, 'TelemetryTick'));
    s = applyNaniEvent(s, ev(2, 'unknown:kind'));
    expect(s.activity).toBe('Observing');
  });

  it('maps investigation lifecycle events to activity states', () => {
    expect(activityForEvent('InvestigationStarted')).toBe('Investigating');
    expect(activityForEvent('InvestigationStageStarted')).toBe('Investigating');
    expect(activityForEvent('InvestigationStageCompleted')).toBe('Investigating');
    expect(activityForEvent('ObservationCreated')).toBe('Observing');
    expect(activityForEvent('EvidenceAdded')).toBe('Observing');
    expect(activityForEvent('ProbeStarted')).toBe('Testing');
    expect(activityForEvent('ProbeCompleted')).toBe('Testing');
    expect(activityForEvent('HypothesisCreated')).toBe('Comparing');
    expect(activityForEvent('HypothesisUpdated')).toBe('Comparing');
    expect(activityForEvent('AnalysisCompleted')).toBe('Analyzing');
    expect(activityForEvent('VerificationCompleted')).toBe('Verifying');
    expect(activityForEvent('InvestigationCompleted')).toBe('Completed');
    expect(activityForEvent('InvestigationFailed')).toBe('Failed');
    expect(activityForEvent('InvestigationCancelled')).toBe('Cancelled');
    expect(activityForEvent('InvestigationUpdated')).toBeNull();
  });

  it('describes investigation lifecycle events', () => {
    expect(describeEvent('InvestigationStarted', { investigation_id: 'inv-1', query: 'why slow?' })).toBe('Investigation started: why slow?');
    expect(describeEvent('InvestigationStageStarted', { stage: 'observe' })).toBe('Stage started: observe');
    expect(describeEvent('InvestigationStageCompleted', { stage: 'observe', ok: true })).toBe('Stage observe completed');
    expect(describeEvent('InvestigationStageCompleted', { stage: 'analyze', ok: false })).toBe('Stage analyze failed');
    expect(describeEvent('ProbeStarted', { api_id: 'api-a', layer: 'dns' })).toBe('Probe started for api-a [dns]');
    expect(describeEvent('ProbeCompleted', { ok: false, api_id: 'api-b' })).toBe('Probe failed (api-b)');
    expect(describeEvent('ObservationCreated', { api_id: 'api-c', layer: 'tcp' })).toBe('Observation for api-c [tcp]');
    expect(describeEvent('EvidenceAdded', { evidence_id: 'ev-42' })).toBe('Evidence added (ev-42)');
    expect(describeEvent('HypothesisCreated', { hypothesis: 'dns issue', confidence: 0.8 })).toBe('Hypothesis: dns issue (confidence 0.8)');
    expect(describeEvent('AnalysisCompleted', { top_hypothesis: 'dns', confidence: 0.9 })).toBe('Analysis complete: dns (confidence 0.9)');
    expect(describeEvent('VerificationCompleted', { verified: true, route_id: 'route-1' })).toBe('Verification passed via route-1');
    expect(describeEvent('InvestigationCompleted', { investigation_id: 'inv-1', result: 'root cause found' })).toBe('Investigation completed: root cause found');
    expect(describeEvent('InvestigationFailed', { investigation_id: 'inv-1', reason: 'timeout' })).toBe('Investigation failed: timeout');
    expect(describeEvent('InvestigationCancelled', { investigation_id: 'inv-1', reason: 'user cancelled' })).toBe('Investigation cancelled: user cancelled');
    expect(describeEvent('InvestigationUpdated', { detail: 'progress' })).toBe('Investigation updated: progress');
  });

  it('describes a completed health check from its measured verdict', () => {
    expect(
      describeEvent('HealthCheckCompleted', { api_id: 'netpulse-cloud', health: 'Healthy' }),
    ).toBe('Health check Healthy for netpulse-cloud');
    // No verdict in the payload must not invent one.
    expect(describeEvent('HealthCheckCompleted', {})).toBe('Health check finished');
    expect(activityForEvent('HealthCheckCompleted')).toBe('Observing');
  });
});

describe('NANI investigation-derived views', () => {
  const baseTime = 1000;

  function invEvent(seq: number, type: string, payload: Record<string, unknown>): NaniEvent {
    return { eventId: `${seq}:${type}`, seq, at: baseTime + seq, type, payload, schemaVersion: 1 };
  }

  it('currentInvestigationId returns the most recent started investigation', () => {
    let s = emptyEventState();
    expect(currentInvestigationId(s)).toBeNull();
    s = applyNaniEvent(s, invEvent(1, 'InvestigationStarted', { investigation_id: 'inv-1', query: 'q1' }));
    s = applyNaniEvent(s, invEvent(2, 'InvestigationStarted', { investigation_id: 'inv-2', query: 'q2' }));
    expect(currentInvestigationId(s)).toBe('inv-2');
  });

  it('currentInvestigationStage tracks stage and clears on terminal', () => {
    let s = emptyEventState();
    expect(currentInvestigationStage(s)).toBeNull();
    s = applyNaniEvent(s, invEvent(1, 'InvestigationStarted', { investigation_id: 'inv-1', query: 'q1' }));
    s = applyNaniEvent(s, invEvent(2, 'InvestigationStageStarted', { stage: 'observe' }));
    expect(currentInvestigationStage(s)).toBe('observe');
    s = applyNaniEvent(s, invEvent(3, 'InvestigationStageStarted', { stage: 'analyze' }));
    expect(currentInvestigationStage(s)).toBe('analyze');
    s = applyNaniEvent(s, invEvent(4, 'InvestigationCompleted', { investigation_id: 'inv-1', result: 'done' }));
    expect(currentInvestigationStage(s)).toBeNull();
  });

  it('investigationObservations returns observations most recent first', () => {
    let s = emptyEventState();
    s = applyNaniEvent(s, invEvent(1, 'ObservationCreated', { investigation_id: 'inv-1', layer: 'dns' }));
    s = applyNaniEvent(s, invEvent(2, 'ObservationCreated', { investigation_id: 'inv-1', layer: 'tcp' }));
    s = applyNaniEvent(s, invEvent(3, 'ObservationCreated', { investigation_id: 'inv-2', layer: 'tls' }));
    const obs = investigationObservations(s, 'inv-1');
    expect(obs).toHaveLength(2);
    expect(obs[0]?.type).toBe('ObservationCreated');
    expect(obs[0]?.payload.layer).toBe('tcp');
    expect(obs[1]?.payload.layer).toBe('dns');
  });

  it('investigationHypotheses dedupes by id keeping latest, sorted by confidence desc', () => {
    let s = emptyEventState();
    s = applyNaniEvent(s, invEvent(1, 'HypothesisCreated', { investigation_id: 'inv-1', hypothesis_id: 'h1', hypothesis: 'dns', confidence: 0.5 }));
    s = applyNaniEvent(s, invEvent(2, 'HypothesisUpdated', { investigation_id: 'inv-1', hypothesis_id: 'h1', hypothesis: 'dns', confidence: 0.9 }));
    s = applyNaniEvent(s, invEvent(3, 'HypothesisCreated', { investigation_id: 'inv-1', hypothesis_id: 'h2', hypothesis: 'tcp', confidence: 0.3 }));
    const hyps = investigationHypotheses(s, 'inv-1');
    expect(hyps).toHaveLength(2);
    expect(hyps[0]!.id).toBe('h1');
    expect(hyps[0]!.confidence).toBe(0.9);
    expect(hyps[1]!.id).toBe('h2');
    expect(hyps[1]!.confidence).toBe(0.3);
  });

  it('investigationOutcome returns terminal outcome most recent first', () => {
    let s = emptyEventState();
    expect(investigationOutcome(s)).toBeNull();
    s = applyNaniEvent(s, invEvent(1, 'InvestigationStarted', { investigation_id: 'inv-1', query: 'q1' }));
    s = applyNaniEvent(s, invEvent(2, 'InvestigationCompleted', { investigation_id: 'inv-1', result: 'root cause found' }));
    const o1 = investigationOutcome(s)!;
    expect(o1.kind).toBe('completed');
    expect(o1.detail).toBe('root cause found');

    s = applyNaniEvent(s, invEvent(3, 'InvestigationFailed', { investigation_id: 'inv-1', reason: 'timeout' }));
    const o2 = investigationOutcome(s)!;
    expect(o2.kind).toBe('failed');
    expect(o2.detail).toBe('timeout');

    s = applyNaniEvent(s, invEvent(4, 'InvestigationCancelled', { investigation_id: 'inv-1', reason: 'user cancelled' }));
    const o3 = investigationOutcome(s)!;
    expect(o3.kind).toBe('cancelled');
    expect(o3.detail).toBe('user cancelled');
  });
});

describe('explaining an empty measurement view', () => {
  it('returns null when nothing failed', () => {
    expect(lastFailedHealthSignal([])).toBeNull();
    expect(lastFailedHealthSignal([ev(1, 'TelemetryTick', {})])).toBeNull();
  });

  it('reports a breaker trip as the reason no measurements exist', () => {
    const signal = lastFailedHealthSignal([ev(3, 'CircuitBreakerTripped', { api_id: 'netpulse-cloud' })]);
    expect(signal).not.toBeNull();
    expect(signal?.label).toBe('Circuit breaker tripped (netpulse-cloud)');
    expect(signal?.subject).toBe('netpulse-cloud');
    expect(signal?.at).toBe(3);
  });

  it('prefers the most recent failure and ignores recovered state', () => {
    const recovered = [
      ev(1, 'CircuitBreakerTripped', { api_id: 'a' }),
      ev(2, 'CircuitBreakerRecovered', { api_id: 'a' }),
    ];
    expect(lastFailedHealthSignal(recovered)).toBeNull();

    const laterFailure = [
      ev(1, 'CircuitBreakerTripped', { api_id: 'a' }),
      ev(2, 'TelemetryTick', {}),
      ev(3, 'CircuitBreakerTripped', { api_id: 'b' }),
    ];
    expect(lastFailedHealthSignal(laterFailure)?.subject).toBe('b');
  });

  it('stops at a later health update, so old failures stop explaining the present', () => {
    const events = [
      ev(1, 'CircuitBreakerTripped', { api_id: 'a' }),
      ev(2, 'nani:health:updated', { api_id: 'a' }),
    ];
    expect(lastFailedHealthSignal(events)).toBeNull();

    // A completed check is observation resuming, whether or not the verdict
    // moved (the desktop emits one per probed API).
    const desktop = [
      ev(1, 'CircuitBreakerTripped', { api_id: 'a' }),
      ev(2, 'HealthCheckCompleted', { api_id: 'a', health: 'Healthy' }),
    ];
    expect(lastFailedHealthSignal(desktop)).toBeNull();
  });

  it('treats an exhausted recovery as a health failure', () => {
    const signal = lastFailedHealthSignal([ev(5, 'nani:recovery:exhausted', { apiId: 'provider' })]);
    expect(signal?.subject).toBe('provider');
    expect(signal?.label.toLowerCase()).toContain('recovery');
  });
});
