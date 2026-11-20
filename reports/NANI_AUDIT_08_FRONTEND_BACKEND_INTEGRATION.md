# NANI_AUDIT_08 — Frontend↔Backend Integration Audit (Mission A, presentation half)

Panel-by-panel truth table for `NaniPage.tsx` (10 tabs) and `CopilotPage.tsx`:

| UI surface | Data source | Backend real? | Reaches UI? | Verdict |
|---|---|---|---|---|
| Overview status (healthy/total, seq) | `nani_status` | ✅ real registry | ✅ | WORKS (1 API universe) |
| "Run health check" button | `nani_health_check_all` | ✅ real HTTP probe | ✅ result string | WORKS |
| Overview recent events | `useNaniEvents` (real bus) | ✅ MonitorLoop emits | ✅ | WORKS (monitor events only) |
| **Live Investigation pipeline** | investigation lifecycle events | ✅ backend emits | ❌ **placeholder bus** | **DEAD** |
| Live event feed | real bus replay | ✅ | ✅ (monitor events only) | WORKS but never shows investigation events |
| Recent investigations cards | `nani_investigations` | ✅ real (in-memory) | ✅ | WORKS; lost on restart |
| Hypotheses tab | `nani_math_hypothesis_view` (Bayesian engine) | ✅ real | ✅ | WORKS — but shows **health-check-fed posteriors**, never investigation diagnoses |
| Evidence tab | `deriveEvidence(events)` | n/a | ❌ event-derived → never sees investigation evidence | EMPTY for investigations |
| Network Intel | drift/changepoint commands | ✅ real (learning-fed) | ✅ | WORKS (needs MonitorLoop history) |
| Learning | `nani_learning_status` | ✅ | ✅ | WORKS (in-memory; resets on restart in practice) |
| History | `listInvestigations` | ✅ | ✅ | WORKS; in-memory only |
| Settings/AI status | `nani_ai_status` | ✅ honest config report | ✅ | WORKS |
| **AI Workspace / Copilot chat** | `nani_explain` local | ✅ real deterministic | ✅ | WORKS — but no history, no streaming, no NANI tools; doc comment falsely claims cloud |
| Web-mode NANI | `/nani/*` sidecar routes | ✅ real (own 2-API registry) | ✅ | WORKS (separate, smaller engine) |
| nani-reports page | — | — | — | DEAD (unrouted) |
| nani-memory hook | — | — | — | ORPHANED |

## Event-contract integrity

`naniEvents.ts` reducer is correct (dedupe/gaps/late-join tested — 30 tests green live). The failure is **upstream**: the producer side wires two buses and the investigation one is the wrong one. Fixing the wiring (N0) activates the existing consumer machinery without touching the reducer.

## The misleading indicators found

1. Copilot header comment claiming cloud connectivity (code does not).
2. Hypotheses tab presenting Bayesian posteriors next to investigation frequency-ratios under the same "confidence" vocabulary.
3. AI Workspace implying conversation persistence/memory; state is per-session only.
4. No "AI unavailable" state distinction — worker 503 renders as a chat error message.
