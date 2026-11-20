# FINAL_UI_ROOT_CAUSE_ANALYSIS — P0–P2 findings

**Reviewer:** Kim · **Scope:** every P0/P2 finding in `FINAL_UI_FINDINGS_REGISTRY.md` (P0 count = 0).

This document answers *why*, not just *what*. Fixes are proposed, not applied, for all items marked `blocked` or owned by Will.

---

## RC-1 · F-01 — Authoritative likelihood change bundled into a UI redesign
**Chain:** NANI-020 ("all-healthy posterior promotes a fault") → fix authored directly in `diagnosis.rs::signature` → working tree now differs from the engine validated by N1.1/N1.2 → UI displays posteriors from an unreviewed model.
**Why it happened:** the redesign task and the NANI-020 math fix shared a working tree. `UI_REVIEW_07` §3 forbids engine changes during the redesign, but nothing in the toolchain enforces the boundary (no diff-scope gate).
**Why it is not auto-fixed:** reverting would delete Will's work and would also discard the genuine improvement it makes; blessing it requires an authorization this mission does not grant.
**Structural remedy:** a separate commit/branch for engine changes with a contract amendment; a diff-scope CI gate on `src-tauri/src/network_intelligence/**` for UI-only missions.

## RC-2 · F-02 — Self-agreement mistaken for calibration ground truth
**Chain:** `observe_recording_confirmation` computes `confirmed = 1` when the leader's log-likelihood (from the same table) ≥ posterior-weighted mean (same table) → samples persisted → `MIN_CALIBRATION_SAMPLES` reached → UI swaps the displayed number for a "calibrated confidence".
**Why it happened:** an available, cheap proxy for correctness was treated as an observed outcome. The engine can always "explain" outcomes under its own likelihood function, so the label is nearly always 1 and the fitted map is close to identity; the claim of empirical calibration is unsupported.
**Impact mechanism:** the user sees two different confidences for one MAP hypothesis with a note implying measurement; trust is placed in a number with no external validation.
**Structural remedy:** require an independent outcome (verified public IP, real target reachability, external probe) before a calibration sample is recorded; otherwise rename the display to "self-consistency".

## RC-3 · F-03 — Attempt count substituted for outcome in the web path
**Chain:** desktop `/nani/check` returns `0/1 healthy`, web runs N checks with no aggregate → `parseHealthCheckResult` has no regex match → returns `healthy = webChecked, total = webChecked` → health tab renders "N/N healthy".
**Why it happened:** the function was written to fill a mandatory numeric shape (`healthy`, `total`) for every path. A nullable representation would have been honest, but the type forced a number.
**Impact mechanism:** a failed `/nani/check` increments the same counter as a success, so missing data becomes a measured success — the exact failure mode mission §4.D prohibits.
**Structural remedy:** make `LastHealthCheck.healthy: number | null`; add an explicit "verdict unavailable" state; never derive a verdict from an attempt counter.

## RC-4 · F-04 — Missing generic on a two-carrier mutation
**Chain:** `useDisconnect` branches on `ConnectionSource`; TypeScript infers the mutation's result type from the first branch (`{tunnel}`); the second branch returns `{status}` → TS2322 → `tsc --noEmit` fails → `vite build` fails.
**Why it happened:** the new module was added as untracked source and evidently never type-checked as part of the author's loop (the baseline test suite runs Vitest but not `tsc`).
**Structural remedy:** explicit `useMutation<Result, Error, ConnectionSource>` with a discriminated result; add `typecheck` to the same CI gate as `test`.

## RC-5 · F-05 — Components added without a mount point
**Chain:** `ConnectionHero`/`ConnectionDial` implement an honest verification surface → no import from any page → dashboard keeps legacy `ConnectionCard` → only a 10px chip consumes `useConnection()`.
**Why it happened:** the redesign was assembled component-first; wiring was deferred and no test asserts that a new component is reachable. Unit tests pass because the components are individually valid.
**Impact mechanism:** the most important honesty feature (tunnel up but traffic unverified) is invisible to users.
**Structural remedy:** a route-render smoke test asserting the dial is present on `/`; keep dead-code detection in review.

## RC-6 · F-06 — NANI-021 (carried) plus a new UI surface
**Chain:** `reqwest::blocking::Client` inherits `HTTP(S)_PROXY` → HTTP layer can be satisfied by a proxy → record hardcodes `RouteKind::Direct` → new `health_check_event` emits `health: "Healthy"` → `naniEvents` renders it as a completed health verdict.
**Why it happened:** the original probe never separated "target reached" from "an HTTP response was received"; the redesign increased the visibility of that verdict without revisiting the measurement.
**Structural remedy (authorized N1.3 work):** `.no_proxy()` on the probe client, a TCP/HTTP route consistency gate, and an honest route value in the event. Until then the limitation must be documented and displayed, not hidden.

## RC-7 · F-07 — Cancellation not re-checked after an await
**Chain:** effect sets `cancelled = false` → `attach()` awaits initial `poll()` → user navigates away, cleanup sets `cancelled = true` and clears `timersRef` (still empty) → `attach()` resumes, creates `setInterval` and pushes it → leaked poll loop.
**Why it happened:** cleanup state was checked inside the ingest callback but not at the asynchronous continuation point.
**Structural remedy:** `if (cancelled) return;` after every await that can outlive the effect; prefer an `AbortController` passed to the poll.

## RC-8 · F-08 / F-09 — Default-to-success event interpretation
**Chain:** `VerificationCompleted` maps anything not explicitly `false` to "passed"; `HealthCheckCompleted` returns `null` ("resume") for every verdict → an absent field or an unhealthy result is rendered as reassurance.
**Why it happened:** optional backend fields were interpreted with a positive default instead of an unknown default.
**Structural remedy:** tri-state mapping (`true`→passed, `false`→failed, absent→unavailable) and verdict-aware resume logic; test every enum value plus absent.

## RC-9 · F-10 — Parallel type scales (verified fixed)
**Chain:** identity layer introduced 9–11px classes while `tokens.css` defines a 12px floor → `typeScale.test.ts` failed → Will removed the offenders → suite green.
**Why it happened:** a new stylesheet established its own micro scale instead of consuming the shared token.
**Why this fix is trusted:** the guard test file is unchanged since 2026-10-02 and its two assertions are intact; source offenders are gone. This is a real fix, not a weakened test.

## RC-10 · F-11 / F-12 — Contract boundary not mechanically enforced
**Chain:** engine regression bars relaxed to relative thresholds; `ProbeSelection` fields removed while frontend changed in lockstep → version skew risk and weaker regression detection.
**Why it happened:** the UI redesign and engine work shared a diff; there is no automated check for "engine diff must be empty" or for JSON shape compatibility.
**Structural remedy:** snapshot tests for DTOs and absolute ECE bounds; a CI check that UI-only missions do not touch `network_intelligence/**`.

## RC-11 · F-13 — Bounded replay fed by unbounded event source
**Chain:** one health event per API per check → bounded replay (256) evicts lifecycle events; internal mpsc unbounded → memory growth under repeated checks; persistence write errors discarded with `let _ =`.
**Why it happened:** bounding was applied at the consumer, not at the producer, and durability was treated as best-effort without logging.
**Structural remedy:** aggregate health events, bound or backpressure the mpsc, log/propagate persistence failures.

## RC-12 · F-14 — "Fix in working tree" conflated with "fixed"
**Chain:** prior Kim review required C-N1.2-1; author applied the conversion in an uncommitted file; no commit followed; HEAD still has the ms-feeder.
**Why it happened:** a review condition was satisfied in a dirty tree and then left ambiguous across sessions.
**Structural remedy:** land the author's hunk with their consent; add a seconds-contract test that runs against the committed path used by builds.

## RC-13 · F-15 — Environment-sensitive acceptance test
**Chain:** N1.1 oracle depends on real loopback probes (port 1), a 6s terminal-state wait, and live DNS; this workspace has proxy interception and load from concurrent agents → full run failed on posterior mismatch, isolated run failed on timeout.
**Why it happened:** a gate intended to be deterministic depends on external network state and wall-clock bounds.
**Structural remedy:** inject deterministic probe fixtures into the oracle; keep the live test separately labelled as an integration smoke. Do not simply raise the timeout.

---

## Cross-cutting root cause

Thirteen distinct findings share one organizational cause: **the redesign was not isolated from engine/network work, and no mechanical boundary enforced `UI_REVIEW_07` §3–§4**. The single highest-value process fix is a diff-scope gate plus a committed-tree test run, so "what builds" is always the thing that was reviewed.
