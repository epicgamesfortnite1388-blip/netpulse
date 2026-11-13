# NANI — Implementation Report (Milestone 1)

NetPulse Adaptive Network Intelligence, implemented in `packages/shared/src/nani`
with a deterministic fault-injection suite in `packages/shared/test/`.

Status: **core intelligence complete and verified; not yet wired into `apps/api`
or the desktop UI.** Details and exact commands are below.

---

## 1. Stage 0 — repository audit (verified, not assumed)

Inspected `E:\Code\Project\Vpn_app` directly:

- npm workspaces: `packages/*`, `apps/*`, `cloud/*`.
- `src-tauri/src` contains the OS shell only: `sidecar.rs`, `ports.rs`,
  `elevation.rs`, `tray.rs`, `window.rs`, `webview_gc.rs`, `safe_mode.rs`,
  `diagnostics`, `navigation`, `os_open`, `updater_feed`.
- The real network/VPN engine is TypeScript in `apps/api/src/services/`:
  `adaptiveEngine.ts`, `healthMonitor.ts`, `diagnosticsService.ts`,
  `egressProxy.ts`, `nodeTestProbes.ts`, `nodeScoring.ts`, `vpnWatchdog.ts`,
  `routeService.ts`, `proxyProbe.ts`, `smartConnect.ts`, `optimiseService`.
- Shared math already lives in `packages/shared/src/adaptive/`:
  a deterministic Beta-posterior contextual bandit (`policy.ts`) and failure
  classification (`classify.ts`, with `dpiInferred: false`).
- Existing tests: 12 files / 158 tests in `packages/shared/test` before this
  change (now 13 files / 209), plus `apps/api/test/*`.
- Working tree already contained user modifications across `apps/api`,
  `src-tauri`, `packages/shared` and docs. **Nothing was reset, stashed,
  cleaned, or reverted.**

### Architectural decision

The brief proposes `src-tauri/src/network_intelligence/`. That would be a second
network engine: the Rust crate supervises a sidecar and does not own probes,
routes, or the VPN engine. Implementing the intelligence there would duplicate
the live engine and split the evidence model in two.

NANI therefore lives in `packages/shared/src/nani/` as pure, deterministic,
I/O-free TypeScript, next to the existing `adaptive/` math. The host
(`apps/api`) supplies probes; the core never opens a socket, reads a credential,
or executes a command. This is also what makes every decision replayable in CI.

No new dependencies were added. `zod`, `typescript` and `vitest` were already
present.

---

## 2. Implemented modules

| File | Responsibility |
|---|---|
| `types.ts` | Evidence model: 14 hypotheses, probe outcomes, `DiagnosticTest`, `DiagnosisOptions`/`Result` (incl. ranked hypotheses), API probe/classification/health contracts, `RouteCandidate`/`RouteFeatures`, recovery policy and steps. |
| `diagnosis.ts` | Uniform prior, floored normalization, Shannon entropy, mean-reverting DBN transition, freshness-weighted tempered likelihoods, Bayesian update, `diagnose`, expected information gain, bits-per-cost test selection. |
| `defaultTests.ts` | 10-test diagnostic library (DNS, gateway, IPv6, TCP, TLS, MTU, HTTP, auth, rate limit, application) with explicit, editable judgment priors. |
| `apiHealth.ts` | Layered failure classification, `assessApiHealth`, bounded exponential backoff with jitter and `Retry-After`, `canRetry`, three-state `CircuitBreaker`. |
| `decision.ts` | Stable sigmoid, seeded PRNG, diagonal-Laplace Bayesian logistic regression, hard-constraint filtering, Thompson-style safe route selection, CVaR latency, multi-objective route cost. |
| `drift.ts` | Two-sided Page–Hinkley and CUSUM change detectors with direction. |
| `metrics.ts` | Brier, log loss, reliability bins, ECE, quantiles/P95/P99, binary precision/recall. |
| `recovery.ts` | Plan generation, receding-horizon controller (one step at a time), cooldowns, attempts bound, rollback on failed probe/activation/verification. |
| `index.ts` | Barrel; re-exported from `packages/shared/src/index.ts`. |

### Mathematics actually implemented

- **Static + dynamic Bayes:**
  `P(H_t | E_1:t) ∝ P(E_t | H_t) Σ_j P(H_t | H_(t-1)=j) P(H_(t-1) | E_1:t-1)`.
- **Transition kernel:** `(1-ε)·[i=j] + ε·prior_i`, ε = 0.05 per observation.
- **Evidence freshness:** `0.5^(age/halfLife) × reliability`; the likelihood is
  tempered toward uniform by that weight, so stale evidence moves the posterior
  weakly rather than being trusted or discarded.
- **Missing data:** `skipped` and `unknown` are excluded, never counted as
  failures; a failed/zero-reliability observation cannot produce certainty.
- **Information gain:** `IG(q) = H(H|E) − E_o[H(H|E,o,q)]`, with `P(o)`
  renormalized over observable outcomes; ranking is `IG / max(cost, 0.05)`.
- **Success model:** Bayesian logistic regression with a diagonal Laplace
  posterior, `precision_i ← precision_i + p(1−p)φ_i²`,
  `w_i ← w_i + (y−p)φ_i/precision_i`, floored precision, and a conservative
  bound at `sigmoid(z − 1.64σ)`.
- **Safe selection:** hard filter on authorization, TLS verification, risk,
  predictive success and expected loss, *then* Thompson sampling; an
  unauthorized route is unreachable regardless of its score.
- **Risk-aware cost:** weighted failure, normalized latency, jitter, loss,
  recovery time, resource cost and risk, with CVaR(0.95) latency.
- **Drift:** Page–Hinkley (`S_t = max(0, S_(t-1) + x_t − m_t − δ)`) and
  two-sided CUSUM.
- **Recovery:** bounded attempts/steps, per-route cooldowns, one-step-at-a-time
  execution, rollback runnable after any failed step on that route.

---

## 3. Defects found and fixed during verification

These were real defects exposed by the tests, not test adjustments:

1. **Information gain double-counted the DBN transition.** Every test appeared
   informative because the transition adds entropy on its own. The update was
   split into "transition" and "apply likelihood", and IG now scores only the
   test. A genuinely flat test now yields IG ≈ 0.
2. **Unnormalized likelihoods distorted IG.** `P(o)` now renormalizes over
   observable outcomes, so a matrix that does not sum to 1 cannot fake
   information.
3. **The MTU probe had no timeout likelihood.** An observed timeout had zero
   likelihood under every hypothesis and was silently discarded. `baseTimeout`
   (0.02) was added; the MTU signal now lives in `timeout: { mtu: 0.55 }`.
4. **`tcp-connect` likelihoods summed above 1** for TCP/routing/endpoint
   (`failure + timeout > 1`). Corrected so each row is a distribution.
5. **A failed probe still allowed activation of that route.** Any terminal
   failure now skips the remaining steps for that route and applies a cooldown.
6. **`attempts` did not count successful activations**, so the bound was
   meaningless. It now counts every activation attempt exactly once.
7. **Export collisions** with `models/map` (`mean`, `LatencySummary`) broke the
   shared barrel; renamed to `meanOf` and `NaniLatencySummary`.
8. **A 15%-confidence "diagnosis" was reported as fact.** `minConfidence` (0.25,
   ~3.5× uniform) was added; below it the result is `insufficient evidence` and
   `top = null`, while `ranked` still exposes the leading hypothesis.

---

## 4. Verification results (actual)

Commands and outcomes:

```bash
cd E:\Code\Project\Vpn_app\packages\shared
npx vitest run        # 13 files, 209 tests passed
npm run typecheck     # tsc --noEmit, exit 0
```

- NANI unit suite: **51 tests passed** (`test/nani.test.ts`).
- Fault-injection simulation: **16 tests passed**
  (`test/nani.simulation.test.ts`).
- Pre-existing shared suite: **142 tests passed**, unchanged.
- Typecheck is clean under the repo's strict settings
  (`noUncheckedIndexedAccess` included).

### Simulated conditions covered

Diagnosis: DNS outage with untestable downstream, DNS-OK/TCP-blocked (leader
`tcp`, correctly flagged as insufficient evidence), TLS certificate rejection,
MTU black hole (timeout), IPv6 down while IPv4 works, API 401, API 429, server
application failure, healthy path (no confident cause).

API classification: DNS, TCP, TLS, 401, 403, 429, 400, 500, malformed body,
timeout, reset; authentication failures map to `fix-credentials`, not a route
switch; TLS failures never recommend disabling verification.

Recovery: direct → approved upstream with real stepwise verification; rollback
after failed verification; refusal when no route is authorized; attempt bounds;
no repeated selection of a cooled-down route; no success indicator before
verification.

Learning/drift: Page–Hinkley detects a route degradation within 10 samples;
online logistic regression beats a fixed 0.5 baseline on chronological
held-out data.

### Calibration numbers (synthetic, 400 rows, 250 train / 150 test)

| Metric | NANI learner | Fixed 0.5 baseline |
|---|---|---|
| Brier | **0.1975** | 0.2500 |
| Log loss | **0.5789** | 0.6931 |
| ECE (10 bins) | **0.0594** | — |

These are early synthetic results, not evidence of production superiority.
Learned weights `[0.52, −0.73, −1.98]` recover the correct direction for both
features but underfit the intercept, which is exactly what the calibration
metrics are there to expose.

---

## 5. Security properties enforced

- TLS verification is never disabled; a test asserts the TLS branch cannot
  recommend it.
- No shell execution, file access, socket, or credential handling in the core.
- Hard authorization/TLS/risk filters run before any scoring; unauthorized
  candidates are rejected with a reason.
- Recovery is bounded by attempts, steps and cooldowns, and every failed step
  restores rollback eligibility.
- Missing evidence is never converted into a failure or a success claim.

---

## 6. Not implemented yet (explicit)

- **No integration into `apps/api`**: the existing `adaptiveEngine`,
  `healthMonitor`, `diagnosticsService` still run on their own logic. NANI is a
  verified library, not yet the live path.
- **No real probe adapter**: nothing calls `nodeTestProbes`/`proxyProbe` through
  NANI yet, so no real-network calibration exists.
- **No UI**: no API control center, recovery timeline, or reactive event layer.
  Stage 1 (typed events, bounded queues, selective subscriptions) is untouched.
- **No persistence**: model parameters, drift state and known-good routes are
  in-memory only.
- **No LLM reasoning layer**; the app remains independent of it by design.
- **No desktop build/package verification** for this change.
- Priors in `defaultTests.ts` are engineering judgment, not measured data;
  they must be recalibrated from captured probes before trusting the numbers.

---

## 7. Next steps (in order)

1. **Adapter in `apps/api`**: implement probes with the existing
   `nodeTestProbes`/`proxyProbe`, feed `diagnose`, and expose one read-only
   diagnostic route. No route changes yet.
2. **API health loop**: register real providers (xKiro, DeepSeek, backend,
   Telegram) and run `assessApiHealth` + `CircuitBreaker` without acting.
3. **Shadow recovery**: run `planRecovery`/`RecoveryController` in dry-run,
   comparing decisions against the current engine before enabling activation.
4. **Persistence**: versioned local schema for observations, model parameters,
   drift state and known-good routes, with reset support.
5. **Stage 1 UI foundation**, then the API control center and live timeline.
6. **Calibration run** over captured data; replace judgment priors and publish
   Brier/ECE before/after.

## 8. Commands

```bash
cd E:\Code\Project\Vpn_app\packages\shared
npx vitest run test/nani.test.ts test/nani.simulation.test.ts
npx vitest run
npm run typecheck
```
