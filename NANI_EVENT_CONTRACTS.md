# NANI Event Contracts

## Normalized client event
```ts
interface NaniEvent {
  eventId: string;      // `${seq}:${type}` — dedupe key
  seq: number;          // monotonic
  at: number;           // ms, 0 if not supplied
  type: string;         // Rust variant or bus topic
  payload: Record<string, unknown>;
  schemaVersion: number;
}
```

## Sources
### Desktop (Tauri)
`{ seq: number, event: { kind: string, payload: object } }` on channel `nani:event`.

### Web (API RealtimeBus)
`{ seq: number, at: number, type: string, payload: object, version: number }`.

## Real event kinds (from Rust `Event` / API)
- `ApiHealthChanged { api_id, previous, current, category, confidence }`
- `FailureDetected { api_id, category, confidence, summary }`
- `RecoveryStarted`, `RecoveryStepCompleted`, `RecoveryCompleted`, `RecoveryRolledBack`
- `RouteSelected { api_id, route_id, reason }`
- `CircuitBreakerTripped`, `CircuitBreakerRecovered`
- `DriftDetected { metric, statistic, threshold }`
- `DiagnosisUpdated { hypotheses: [name, probability][] }`
- `LearningUpdate { metric, value, context }`
- `TelemetryTick { timestamp_ms, healthy_apis, total_apis }`
- `UserAction { action, api_id, success }`
- API bus: `nani:health:updated`, `nani:diagnosis:completed`, `nani:recovery:planned`, `nani:recovery:step:*`, `nani:recovery:exhausted`, `nani:route:activated`

## Activity mapping
| Event | Activity |
|---|---|
| TelemetryTick / nani:health:updated | Observing |
| FailureDetected / nani:diagnosis:completed | Analyzing |
| ApiHealthChanged | Verifying |
| DiagnosisUpdated | Comparing |
| DriftDetected | Analyzing |
| RecoveryStarted / nani:recovery:planned | Planning |
| RecoveryStepCompleted / nani:recovery:step:* | Testing |
| RecoveryCompleted | Completed |
| RecoveryRolledBack / CircuitBreakerTripped / nani:recovery:exhausted | Failed |
| RouteSelected / nani:route:activated | Verifying |
| CircuitBreakerRecovered | Completed |
| LearningUpdate | Learning |
| UserAction | Completed |
| unknown | unchanged |

## Validation
- Malformed envelopes (missing `kind`/`type`, non-object payload) are rejected by `fromTauriEvent` / `fromBusEvent` (return `null`).
- No payload field is trusted for authorization or measurements; payloads are display-only.
