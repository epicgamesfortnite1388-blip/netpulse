# NANI_AUDIT_09 — End-to-End Test Matrix (Mission H)

Classification: PASS / FAIL / BLOCKED / NOT IMPLEMENTED. Evidence: code traces + executed test commands this session (`cargo test investigation` 8✓, web nani 30✓) — no invented results. Live desktop E2E was NOT run (requires launching the packaged app; recorded as method limitation, not as pass).

| # | Test | Classification | Evidence |
|---|---|---|---|
| 1 | Start investigation → real investigation begins | **PARTIAL FAIL** | lifecycle starts (bg thread, id returned) but observes an EMPTY registry → zero probes (investigation.rs:528 + main.rs:247) |
| 2 | Invalid input (empty/long query) | PASS | nani.rs:123–128 validation |
| 3 | Probe execution (real test runs) | PASS (health path) / FAIL (investigation path) | monitor.rs probes real endpoints via health-check; unreachable from investigations |
| 4 | Probe timeout bounded | PASS (TCP/HTTP) · PARTIAL (DNS: `to_socket_addrs` unbounded ⚠️) | monitor.rs |
| 5 | No network → failure evidence | PASS (health path) / NOT IMPLEMENTED (investigation path — no probes to fail) | — |
| 6 | DNS failure distinguishable from TCP | PASS (health path) | failure_classifier per-layer |
| 7 | Healthy network → no invented fault | PASS | honest Health enum; no fabrication found |
| 8 | Conflicting evidence → uncertainty | NOT IMPLEMENTED END-TO-END (math supports it; investigation path bypasses math) | — |
| 9 | Insufficient evidence → no false certainty | PASS (mechanism) / FAIL (investigations never have evidence anyway) | `insufficient` flag |
| 10 | Duplicate evidence not double-counted | PASS (unit) | bayesian.rs dedupe + adversarial tests |
| 11 | Stale evidence handled | NOT IMPLEMENTED END-TO-END (decay exists; nothing persists to age) | — |
| 12 | Verification of hypothesis | FAIL (investigation verify: empty registry → false) | run_verify_stage:716 |
| 13 | Report creation (durable) | NOT IMPLEMENTED | no report builder/store |
| 14 | Report retrieval | NOT IMPLEMENTED | dead nani-reports page |
| 15 | Investigation failure visible & preserved | PARTIAL (visible in-memory; lost on restart; errors honest) | — |
| 16 | Copilot without provider → honest unavailable state | FAIL (as-designed honesty exists upstream: worker 503; but desktop path never calls it → UI shows local answer without stating mode; no availability distinction) | aiApi.ts + nani.rs:336 |
| 17 | Copilot with provider → real API call | NOT IMPLEMENTED in desktop path / BLOCKED in worker path (`ABYSTRAL_AI_BASE_URL=""`) | index.ts:1243 |
| 18 | Invalid credential → actionable provider error | NOT IMPLEMENTED (no credential path exists in NetPulse) | — |
| 19 | Provider timeout → recoverable | NOT IMPLEMENTED (no provider call) | — |
| 20 | Streaming cancellation | NOT IMPLEMENTED (single-delta fake streaming; AbortSignal exists frontend-only) | aiApi.ts:89 |
| 21 | NANI tool call → real structured data | NOT IMPLEMENTED (no tool layer) | — |
| 22 | Unauthorized action rejected | NOT IMPLEMENTED for AI tools (recovery gating exists separately and is tested) | naniRecoveryControls tests |
| 23 | Conversation persistence | NOT IMPLEMENTED (useState only) | CopilotPage |

## Score: 5 PASS, 3 PARTIAL/conditional, 1 FAIL-structural, 13 NOT IMPLEMENTED, 1 BLOCKED — out of 23.

A passing unit test does not prove E2E — explicitly acknowledged: the 8 investigation unit tests pass while the production wiring is severed (they inject their own registry/bus), which is precisely the Phase-1 lesson ("tests exercise components, not assembly").
