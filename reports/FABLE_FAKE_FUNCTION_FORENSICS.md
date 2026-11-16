# FABLE — Fake Function Forensics

Method: pattern sweep (`fake|simulated|placeholder|hardcoded|mock|Math.random()|return ok:true`) across all Rust and TS sources, followed by manual reachability checks of every hit. Conclusion up front, because it contradicts the suspicion this audit was asked to confirm:

**This codebase contains no reachable fake measurement or fake-success paths in production code.** The pattern hits were benign, test-only, or honest-degradation paths. Detailed adjudication:

## 1. Findings and verdicts

| # | Location | What was suspected | Verdict | Reason |
|---|---|---|---|---|
| F-01 | `aether-1793627158015.zip` etc. (root, 9–47 B) | Fake archives | **REMOVE** (repo hygiene) | Contain literal `Not Found` — failed HTTP downloads committed to the tree. Not referenced by any build script. |
| F-02 | `apps/web/src/features/nani-reports/` | Phantom UI | **REMOVE** | Single page file; not in `router.tsx`, not imported anywhere. Dead UI implying a NANI reports feature that does not exist. |
| F-03 | `simulation.rs` (Rust, 501 L) | Simulated network in production | **KEEP AS TEST FIXTURE** | Deterministic, seeded simulator used only by tests/benchmarks (`bench-adaptive-*`, `evaluation.rs` tests). Not reachable from any Tauri command. |
| F-04 | `apps/api/src/services/nodeTestProbes.ts:255` | Fake latency | **KEEP (honest)** | Comment is the opposite of fake: "No fake 200s — latency is measured only when traffic provably traversed." |
| F-05 | `apps/api/src/services/iranService.ts:488` | Fake reachability | **KEEP (honest)** | `rejectUnauthorized: false` is used to REPORT certificate failures rather than fake reachability — the anti-fake posture. |
| F-06 | `providers/speed/cloudflare.ts:41` | Simulated speed | **KEEP (honest)** | Measures real bytes over the window; verified code shape (undici streams). |
| F-07 | `routes/nodes.ts:744`, `routes/tunnel.ts:50` | Simulated progress/TUN | **KEEP (honest)** | "Progress counters reflect actual probe outcomes — no simulation"; TUN degrade sets `tunError`, "never a silent fake". |
| F-08 | 63 `return { ok: true … }` hits | Constant success | **KEEP** | Sampled all: they acknowledge accepted requests or carry real payloads (`scanId`, session TTL, applied strategy). None fabricate outcomes. |
| F-09 | `Math.random()` hits (8 in api) | Randomized results | **KEEP** | All are: DNS transaction IDs, job/endpoint IDs, prune scheduling (`stabilityService.ts:138`, 1/50 ticks), request IDs. No measurement randomness. |
| F-10 | `stabilityService.ts:138` | Fake sample | **KEEP** | Random used only to occasionally trigger DB prune; samples come from real probes. |
| F-11 | `naniApi.ts` "no mock path" claim | Hidden mock | **VERIFIED TRUE** | Every function routes to Tauri command or real API route; `hasTauriIpc()` is capability detection, not a mock branch. |
| F-12 | `routes/webrtc.ts` | Fake leak test | **KEEP (honest)** | Compares real browser STUN candidates against measured public IPs; stores a test record. |
| F-13 | cloud worker `ABYSTRAL_AI_BASE_URL=""` | Fake AI | **KEEP (explicit unsupported)** | Returns 503 with no fake responses when unconfigured — the correct posture. |
| F-14 | `evidence/leak-live-20261112/` | Fabricated evidence | **INVESTIGATE** (data sensitivity) | Field-evidence artifacts; verify no user-identifying data is committed. |
| F-15 | `apps/api/dist/aetherProvider-*.js` (many variants) | Stale artifacts | **REMOVE** (hygiene) | Dozens of stale hashed chunks; not in any deploy path (bundle is `src-tauri/backend`). |
| F-16 | `ai-agent` service dir | Fabricated reasoning | **KEEP (honest)** | AI agent has no authority to alter state; explanations only (consistent with the NANI LLM boundary in Rust `ai/mod.rs`). |

## 2. What a correct implementation would do — and where the code already does it

For every fake-prone surface the correct implementation exists and was traced: tunnel `active` requires proven traffic; engine installs require digest + self-check; exit IP is observed, not asserted; NANI posteriors are fed only by real probes (`monitor.rs` DNS/TCP/TLS/HTTP) with per-layer classification; the local LLM cannot add measurements or change decisions (`ai/mod.rs` header contract).

## 3. Residual risks (not fake, but worth watching)

1. **F-02 dead page** may mislead future agents into "implementing" NANI reports as if a spec existed. Delete.
2. **F-01/F-15 committed garbage** trains future audits wrong. Clean.
3. The only remaining place a future contributor could plausibly introduce fake data is `simulation.rs` leaking into `evaluation`-driven UI metrics. Guard: keep `NetworkSimulator` `#[cfg(test)]`-gated or behind a `bench` feature. (Currently only test/bench callers — verified.)
