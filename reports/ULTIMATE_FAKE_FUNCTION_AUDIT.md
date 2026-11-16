# ULTIMATE FAKE-FUNCTION AUDIT

**Audit date:** 2026-11-16 · Scope: `src-tauri/src`, `apps/api/src`, `packages/shared/src`, `apps/web/src`, `cloud/worker/src`. Read-only investigation; every finding has file:line evidence. **[V]** verified from code · **[A]** analysis.

---

## 1. Headline result

**[V]** This codebase is substantially more honest than typical for its size. It contains a deliberate anti-fake engineering campaign ("never a fake success", "No fake 200s", "No mock path"). There are **zero** `todo!()`, `unimplemented!()`, `unreachable!()`, or TODO/FIXME/HACK markers in the focus source. All fake/corrupt findings below are specific and localized, not systemic.

| Pattern | Count (focus source) |
|---|---|
| `todo!()` / `unimplemented!()` / `unreachable!()` | 0 |
| `panic!()` | 16 — all in `#[cfg(test)]` / `tests.rs` |
| `unwrap()` / `expect()` | 156 / 209 (includes tests) |
| `commands/nani.rs` unwrap/expect/panic | **0** |
| `let _ = <Result>` ignored | 92 |
| `verified: true` literals in catalog data | ~23 |

## 2. Confirmed FAKE functionality (fabricated values shown as real)

**F1 — Hardcoded NANI probe reliability weights [V] [HIGH].** `apps/api/src/services/naniProbeAdapter.ts:61,68,80,97,113,130,146` sets `reliability` to literal `1 / 0.5 / 0.9 / 1.0 / 0.95` per probe layer. `packages/shared/src/nani/diagnosis.ts:115-116` computes `weight = decay × reliability`, which directly scales Bayesian likelihoods and the user-visible confidence (`naniService.ts:301`). These are **asserted, not measured**. This is the only fake value confirmed to be on a production path that materially affects diagnostic output.
- *Real implementation should be:* empirical per-probe reliability estimated from historical success under known conditions, or — if unavailable — an explicit "uncalibrated" label rather than a precise-looking number.

**F2 — Config-scoring placeholders [V] [MED].** `src-tauri/src/network_intelligence/config_intelligence.rs:361-370` emits `expected_latency_ms: 100.0, latency_std_ms: 20.0, jitter_ms: 10.0, packet_loss: 0.01, stability: 0.8, freshness: 1.0` with a `// placeholder` comment; `:349-358` applies arbitrary status multipliers (AppVerified ×1.2, Reachable ×1.1, Parsed ×0.9, Discovered ×0.8). Reachable via public `foundation::score_config`; no in-repo production caller found. Six invented metrics are indistinguishable from measured ones if surfaced.

**F3 — `verified: true` catalog claims [V] [MED].** `apps/api/src/services/dnsResolverCatalog.ts:140-143` flags a resolver `verified: true` while its own note says it "did not answer from this test network", with a single hardcoded `VERIFIED_AT` timestamp applied to ~12 resolvers. `gameCatalog.ts` has 9 similar hardcoded flags. "Verified" here means "documented at authoring time", not live-verified — the UI may overstate certainty.

**F4 — Precision-looking confidence rendering [V] [LOW-MED].** `apps/api/src/services/naniService.ts:301` renders `Math.round(confidence*100)%`. With F1 and expert priors (`diagnosis.rs:219-390`), this implies statistical calibration that does not exist in production (calibrators are test-only: `evaluation.rs:246-281`).

**F5 — Unconditional `grounded: true` [V] [MED].** `src-tauri/src/network_intelligence/ai/explanation.rs:116-123` marks LLM narrative as grounded without validating it against evidence; the frontend concatenates it unchecked (`naniApi.ts:151`). The prompt forbids invention, but output is not verified. Violates the requirement "LLM must not invent evidence".

## 3. Misleading success / failure-suppression (real failures hidden) [V]

**F6 — "connected" survives failed traffic verification [V] [HIGH].** `apps/api/src/vpn/vpnService.ts:366-372`: `verifyConnect` returns `verification:'failed'` when public IP is unchanged, but spreads the original status with `connected:true`. The `/api/v1/vpn/status` handler selects on `s.connected` alone, so the UI reports a connection that was not proven to route traffic. Combined with OpenVPN's 3-second survival heuristic (`:888-903`, `:910`), this is the strongest "fake connected state" risk. Aether and xray paths do perform real verification, so this is a shared-helper weakness, not a wholly fake engine.
- *Note:* the source comment at `:307-312` explicitly says a failed check "never flips connected" — so this is deliberate design, but it conflicts with the audit requirement "Do not report an engine as connected simply because its process started."

**F7 — Silent audit writes [V] [MED].** `cloud/worker/src/netpulse-integration.ts:340` (`syncNetpulseEntitlements(...).catch(() => {})`), `:53,75`; `netpulse-sessions.ts:101,138,149`; `cloud/worker/src/index.ts:286` (2% random expiry sweep) — entitlement-sync failures, session revocations, and reject-webhook audit events can vanish silently; expired data may persist indefinitely on low-traffic workers.

**F8 — Ignored persist Result [V] [MED].** `src-tauri/src/network_intelligence/persistence.rs:250` — `set_model_state` updates memory and discards the persist error; disk and memory can diverge. (Adjacent serialization bug fixed this audit — see corruption audit.)

**F9 — Empty catch blocks [V] [LOW].** `cloud/worker/src/ops-page.ts:465,519` — token persistence failure invisible to operator.

**F10 — Weak secret self-test [V] [LOW-MED].** `apps/api/src/services/vpnSelfTestService.ts:212-222` accepts any parseable JSON as a valid credential for unknown providers, so `state:'ok'` can mean "non-empty" rather than "usable".

## 4. Unreachable / dead fake-adjacent surfaces [V]

- **`config_intelligence.rs:361-370`** (F2) and **`foundation.rs:985-992`** `simulate_probe` — simulator compiled into production binary, no production caller; only tests/eval use it. Not fake output today, but a live footgun.
- **`information_theory.rs:256-278`** — cost-aware probe selection uses hardcoded IG/cost constants (API 0.05/1.0, recovery 0.2/3.0) and the function has no production caller.
- **`causal.rs:126-186`** — ATE tracker with no production caller.
- **`apps/web/src/features/nani-memory`** — orphan extensionless file with undefined identifiers (`useCallback`, `usePersistentState`); unreferenced, would fail typecheck if imported. See corruption audit.
- **`apps/web/src/features/nani-reports/nani-reports-page.tsx`** — fully built but unrouted page.

## 5. Classified as legitimate (negative findings) [V]

- **No fake VPN engines.** All engine binaries/config/verification are real (see VPN audit). The only stub (`CustomProvider`) throws an honest 501.
- **No simulated data in product output.** Simulator call sites are tests/eval only.
- **AI local runtime** (`ai/local_runtime.rs`) is disabled by default, rejects prompt echo and empty output — no canned answers.
- **`nodeActionPolicy.ts:240`** explicitly refuses to invent placeholder success ("Unverified is its own honest outcome").
- **Failed probes ≠ confirmed failures** in diagnosis (`diagnosis.rs:107-118`, `measurements.rs:12-29`).

## 6. Recommendation priority

1. **F1** — replace hardcoded probe reliabilities with measured estimates or label them uncalibrated; this is the only fabrication proven to reach user-facing confidence on every NANI run.
2. **F6** — make failed traffic verification revoke `connected` (breaking change; requires product decision + regression tests across engine paths).
3. **F3/F4** — rename "verified" to "documented" in catalogs; label confidence as heuristic.
4. **F5** — validate LLM narrative against evidence before setting `grounded`.
5. **F7/F8** — stop swallowing security/persistence failures; surface them.

No production file was changed in response to this audit's fake-function findings (they require design decisions). The one fabricated-but-dead function (`LocalInterface` arm) that was a code defect was fixed — see corruption audit.
