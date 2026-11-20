# N1_REVIEW_01 — Independent Adversarial Code Review of N1.1

**Reviewer:** Kim — Code Review Expert
**Date:** 2026-11-17 · **Target:** HEAD `0a3cce5` · **Mode:** read-only
** stance:** the implementation is a diagnostic system whose conclusions may steer user decisions; every layer was attacked.

---

## 1. Executive verdict

### APPROVED WITH CONDITIONS — N1.2 AUTHORIZED: **YES** (with two tracked conditions, §13/§14)

The core claim survives adversarial scrutiny: **the Bayesian engine's posterior genuinely drives the real investigation result** — proven by an oracle this reviewer verified is independent of the lifecycle's computation, and by a tripwire demonstrating the lifecycle *disagrees* with the old ratio algorithm on the same evidence (the required A-ranks-posterior/B-ranks-ratio case, §3). All reported test numbers were reproduced exactly. No CRITICAL defect was found. Two HIGH-severity issues were identified — both **outside the committed N1.1 diff**: one lives in uncommitted concurrent work (K-1), one is a corrected root-cause analysis of NANI-021 (§7). Neither invalidates the integrated analysis path; both have concrete, small corrections.

## 2. Git state and preservation

- Branch `main`, HEAD `0a3cce5`, linear on top of `481f6b3` (N0). Nothing pushed.
- `200de54` touches exactly `src-tauri/src/main.rs` (+13/−2) and
  `src-tauri/src/network_intelligence/investigation.rs` (+820/−112 lines incl. tests).
- `5b65737` touches exactly one line of `scripts/e2e-desktop.mjs`. Verified isolated.
- `0a3cce5` is reports + registry. **Registry integrity verified by diff:** 33 → 36
  entries, zero lost, only NANI-003 modified among pre-existing entries.
- The concurrent user's in-flight files (19 modified, 51 untracked) are absent
  from all three commits. Preservation confirmed. This reviewer modified nothing.

## 3. Review A — Bayesian authority (call graph traced in committed code)

```
probe_api (monitor.rs, unchanged)
  → diagnostic_probes(&outcome)            [monitor.rs:245 — was dead, now live]
      → ts /= 1000 (investigation.rs:774)  [seconds; see §8]
          → DiagnosticEngine::observe      [investigation.rs:778 — per-investigation engine]
analyze:  engine.diagnosis()/ranked()      [investigation.rs:883]
          → HypothesisCreated/Updated, AnalysisCompleted (existing schemas)
verify:   verify_layer_for(top) → re-probe implicated layer
          → engine.observe (filtered, discounted)   [investigation.rs:993]
          → engine.diagnosis() again → final top/confidence [investigation.rs:662]
result:   floor check on the FINAL posterior → result text → finish_completed
```

1–3, 5–7 **verified in code**: every `inv.confidence`/`inv.top_hypothesis`
write comes from `engine.diagnosis()` (pre-verify at :614, final at :670);
ranking comes from `engine.ranked()`; the verdict is the floor check on the
final posterior. **No ratio fallback exists in production** — the only
`layer_stats`/ratio code in the file is inside the tripwire TEST that
reimplements the old algorithm to prove disagreement.

**Adversarial A-vs-B test (required by the brief) — satisfied by construction
and demonstrated:** with the failing-leg fixture, the old algorithm ranks a
layer at ratio 1.0 ("tcp"); the posterior ranks `application_failure` at
≈0.47. The tripwire asserts the lifecycle's reported confidence equals the
engine posterior and disagrees with the ratio; the oracle asserts exact
equality with the engine. Therefore the final result follows the posterior,
not the ratios, in exactly the divergence case the brief demanded.

**Verification-changes-the-posterior test (required):** the oracle
reconstructs the verification measurement from the recorded verify
observation and asserts the FINAL reported verdict equals the reference
engine's post-verification posterior — stale pre-verification values would
fail (the pre-verify and post-verify tops differ in this fixture).

4. **Bridge correctness:** `diagnostic_probes` maps layers→tests, classifies
   HTTP status into the six-outcome model, maps Unknown→Missing, scopes
   sources per API. It bypasses no validation — it consumes the same
   `ProbeOutcomeRecord` the observations come from. Its own unit tests pin
   the mapping. One honest blind spot: the oracle reuses the bridge (§10, K-6).

**10. Event payload vs final result:** `AnalysisCompleted` honestly describes
the PRE-verification analysis; the final truth reaches the status card via
`inv.top_hypothesis/confidence` (updated post-verify) and the result text.
Two-snapshot semantics — documented as K-4 (LOW).

## 4. Review B — Mathematical integrity

- Engine code: **zero changes** (`git show 200de54` touches no file under
  diagnosis/math/probability). All numerical guarantees are inherited and the
  full suite (541/0, re-executed) covers them.
- **Confidence semantics (the mislabeling audit):** every published
  confidence field is a **posterior probability** from one distribution —
  `HypothesisCreated/Updated` (ranked posteriors), `AnalysisCompleted.confidence`
  (MAP posterior), investigation `confidence` (final posterior). None is
  presented as calibrated: the math surface explicitly distinguishes
  "Calibrated confidence" vs raw ("hypothesisView.ts:42–68", concurrent work);
  the investigation card labels it plainly "Confidence" (K-5, LOW — could say
  "posterior"). No thresholded or ranking-score masquerade found.
- Dedup/repeat/correlation: engine-internal, untouched; the lifecycle adds no
  re-counting; the oracle asserts correlated layers stay < 0.99.
- Verified-only learning: no verified-learning path was touched; the
  `LearningEngine` feed is unchanged advisory bandit/drift.

## 5. Review C — Verification targeting

Verified in committed code: layer derived from the leader
(`verify_layer_for` — all 19 labels mapped), API selected by *failing the
implicated layer* (relevant, not arbitrary), association via investigation id,
re-entry through `observe` (correlation-discounted → no amplification), final
verdict from the updated posterior, Missing ≠ success (result kind recorded
from the real layer outcome).

**K-3 (MEDIUM) — verdict prose inverted for reproduced failures:** the space
has no healthy hypothesis, so leaders are failure modes. When verification
re-measures the implicated layer and it **fails again**, the failure is
*reproduced* — the strongest possible confirmation of a failure hypothesis —
yet `verified=false` and the result reads "not verified; treat as uncertain."
The posterior/confidence numbers are correct (the engine absorbed the
re-measurement and the leader typically rises); only the prose and the
`verified` boolean's interpretation are inverted for this case. A refuted
leader (layer passes) reads correctly. **Recommended correction (small,
non-blocking):** three-way outcome in the result text — reproduced / refuted /
unmeasured — and keep `verified` strictly as the re-measure outcome.
Does not block N1.2; the numeric verdict is trustworthy today.

**Non-discriminative verification (C.10):** re-running the implicated test
adds the same likelihood rows; hypotheses that predict the observed outcome
identically are not separated by verification. The system does not overstate
this — "confirmed" is tied to the posterior probability, not to a claim of
causal isolation — but a future IG-guided verification (`rank_tests` exists in
diagnosis.rs) would be the principled upgrade. Noted for N5/roadmap.

## 6. Review D — Insufficient evidence and no-fault bias

- No observations → failure: verified (pre-existing early path, unchanged).
- All-healthy → `(None, 0.0, false)`: verified — and `status.top_hypothesis`
  is genuinely `None`, so **no leading hypothesis reaches the UI for a
  healthy network**; the refusal text is verbatim-preserved (test-asserted).
- Floor: `confidence < 0.25` — at **exactly 0.25 the conclusion is justified**
  (strict less-than). Boundary documented. The constant is the pre-existing
  one, now applied to real posteriors; ~4.8× uniform over 19 hypotheses. It is
  a policy constant carried forward, not a new arbitrary heuristic — but its
  calibration against real posterior distributions is unvalidated (T-05 rule:
  posteriors are scores until n ≥ 100 && ECE < 0.10). Track, don't block.

**NANI-020 assessment:** with the no-claim rule, no user-facing output on a
healthy network shows a leading hypothesis (verified: `top_hypothesis = None`,
no HypothesisCreated events, no verify, refusal text). A false diagnostic
explanation is therefore not reachable through the investigation path. The
artifact remains visible only inside the engine's raw posterior (queryable via
math surfaces). Verdict: **tracked model limitation; does not block N1.2.**
Recommendation: a `Healthy/NoFault` hypothesis with audit-approved likelihood
rows in N5, OR a smaller earlier correction — an explicit all-healthy
detector (all layers Ok ⇒ bypass the posterior and report "no failure
measured") in the lifecycle, which is cheaper and honest. Either is
acceptable; the second is a two-line N1.x hygiene item.

## 7. NANI-021 — technical analysis and recommendation (root cause CORRECTED)

**The reported "transparent interception" is not what is happening.** This
reviewer reproduced and isolated the mechanism:

- `node fetch` (undici — no system-proxy pickup) to `127.0.0.1:1`:
  **fails in 23 ms** (connection refused).
- `curl` (no proxy env): **000 in 2.6 ms** (refused).
- reqwest 0.12.28 (`Cargo.lock`): receives **HTTP 503 in ~240 ms**.

Diagnosis: **reqwest ≥0.12 reads the Windows system proxy by default.** The
machine's system proxy is `127.0.0.1:10809` (the user's separate proxy tool).
`probe_http` therefore sends its request **through the user's proxy**, and the
503 is the *proxy's* "target unreachable" answer — not a response from the
target, and not OS-level transparent interception (the direct path provably
refuses instantly). The TCP probe (std::net) measures the direct path; the
HTTP probe measures the proxy's view. **Two different network paths inside one
probe record — contradictory layer evidence by construction** in exactly the
environments (censorship circumvention) where users run system proxies as the
norm.

**Recommendation — hybrid:**
1. **Option A, one line, do first:** `reqwest::Client::builder().no_proxy()`
   in `probe_http` (and the same for any other measurement-grade client).
   Portable (pure application-level), restores path consistency between TCP
   and HTTP layers. Application-level enforcement cannot defeat OS-level
   transparent interception (WFP/TUN) — nothing at app level can — but on this
   machine the direct path demonstrably works once the proxy pickup is removed.
2. **Option B as a cheap consistency gate, not a new outcome yet:** when the
   TCP layer failed but the HTTP layer reports success, an HTTP "success"
   cannot have originated from the target → feed **Missing** for that layer
   and flag interception in the probe detail. This reuses the existing
   six-outcome semantics (Missing = "could not measure the target") with no
   likelihood-table change and no silent reinterpretation. A new
   `Intercepted` outcome (7th) would require re-auditing every likelihood row —
   not justified until the gate proves insufficient.

**Implications:** probe contract gains a documented "direct path" guarantee;
evidence provenance gains an interception flag; likelihoods unchanged;
backward compatibility unaffected (pure tightening); UI gains an honest
"measured through an intermediary" indicator where detection fires.

**Blocker status:** **does not block N1.2** (configurable registry — orthogonal
surface). **It does block trusting health classifications and diagnostic
conclusions in proxied deployments** — the fix belongs in N1.3's probe work
(alongside the DNS timeout) and should be treated as the first item there.

## 8. NANI-022 — timestamp units (UPGRADED in impact; the hazard is live)

**K-1 (HIGH, in uncommitted concurrent work):** there is a **second production
engine feeder**: the manual health-check command (`commands/nani.rs:313`,
in-flight user work) feeds `diagnostic_probes(&outcome)` into
`math.observe_probe_recording(probe)` **without the seconds conversion**. Those
`ProbeResult`s carry millisecond timestamps into `predict(delta)`, which is
calibrated for seconds — a 5 s gap yields `mix = exp(-5) ≈ 0.007`, i.e. each
manual check nearly resets the shared long-lived `state.math` engine toward
the stationary distribution. The `nani_math` diagnosis surface fed by that
engine cannot accumulate evidence across checks. The committed investigation
path is unaffected (per-investigation engine, seconds only).

Answering the brief's questions: the unit is **not** clearly established
(NANI-022's root); a ms timestamp **can** and now **does** enter a
seconds-calibrated function; existing tests would **not** reliably catch a
1000× error in that path (the manual-check path has no unit assertion).

**Recommendation:** (a) immediate small fix at the `nani.rs` call site
(`/1000`, same as the investigation path) — coordinate with the concurrent
author since the file is their WIP; (b) then the durable fix: a documented
unit contract now, and a newtype (`Seconds(u64)` or `Timestamp` wrapper) at
the next safe refactor moment — do not rewrite the engine now. **N1.2 may
proceed**, with the condition that the unit fix lands before the
`nani_math` diagnosis output is presented as trustworthy.

## 9. Review G — concurrency and panic safety (verified independently)

- **Cap enforcement:** check and slot accounting are under one lock for the
  *check*, but **K-2 (MEDIUM): the `active.insert` happens in a second lock
  acquisition** — two simultaneous starts can both pass the cap check and both
  insert, transiently exceeding 4. Practically mitigated (single UI caller,
  honest rejection is the fallback), but the invariant is breakable.
  **Correction:** perform check+insert in one critical section (insert inside
  the first lock block). Non-blocking for N1.2; fold into the next commit batch.
- No second entry point bypasses the cap (single `start()`; the manual-check
  command does not create investigations).
- **Panic:** `guarded_lifecycle` wraps the entire staged body; on unwind it
  runs the normal `finish_failed` → `retire_from` path (slot released, bounded
  history, honest `InvestigationFailed`, never a completion — all
  test-asserted). Boundary correct; cleanup guaranteed by construction.
- Stress: `n1_concurrency_limit_rejects_honestly_and_releases` re-executed
  (16/16 investigation tests); sequential-start suites (`history_is_bounded`,
  60 starts) green under the cap.

## 10. Review H — test quality (all numbers reproduced)

| Command (this reviewer, read-only) | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml investigation` | **16 passed, 0 failed** |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **541 passed, 0 failed, 2 ignored** |
| `npx vitest run src/features/nani` | **34 passed** |
| `npm run e2e` | **44 passed, 0 failed** |
| `cargo test … n1_analysis_latency -- --nocapture` | 80 probes / 20 APIs in 2.48 s |

**Oracle independence audit:** the reference builds a **fresh**
`DiagnosticEngine` from `record.observations` (recorded evidence, not a
precomputed result) and does not read the lifecycle's posterior. It detects:
incorrect observation input (everything is record-driven), transition timing
(timestamps from the record drive the predict steps), stale pre-verification
results (the verify step is reconstructed and the FINAL verdict is compared),
and ratio regression (exact-match + tripwire + distribution-validity
assertions). **Shared-implementation blind spot (K-6, LOW):** the oracle
reuses `diagnostic_probes` and the engine's own math — a bug in the bridge
mapping or likelihood table would be invisible to it. Mitigated: the bridge
has its own unit tests (mapping, status classification, Missing semantics)
and the likelihood table is the audited, separately-tested engine component.
A future hardening could hand-map layer→test in the oracle.

## 11. Review I — performance

Re-executed: 80 real probes × 4 layers through the engine in 2.48 s —
probe-dominated; Bayesian work is µs/probe (O(19) log-space update, O(1) in
session length via the bounded 32-entry correlation window). No unnecessary
recomputation (analyze reads the posterior built during observe; verification
adds exactly one filtered re-measurement). No large clones (engine passed by
reference), no shared-lock analysis (per-investigation engine), bounded
buffers (256-event replay, top-5 hypotheses, 50-record history, 4-investigation
cap). No blocking on the UI thread (background lifecycle thread). Memory: no
unbounded growth found. No changes made.

## 12. Findings by severity

| ID | Sev | Status | Location | Risk | Blocks N1.2 |
|---|---|---|---|---|---|
| K-1 | HIGH | OPEN (uncommitted concurrent work) | `commands/nani.rs:313` manual-check engine feed | ms timestamps → predict over-mixing → `nani_math` diagnosis cannot accumulate evidence | NO — conditional (fix before trusting that surface) |
| NANI-021 | HIGH | OPEN (root cause corrected) | `monitor.rs probe_http` reqwest client | probes measure the user's proxy, not the target; health + Bayesian evidence corrupted in proxied deployments | NO — fix first in N1.3; blocks shipped diagnostics |
| K-2 | MEDIUM | OPEN | `investigation.rs start()` cap check vs insert in separate locks | cap can be transiently exceeded under simultaneous starts | NO |
| K-3 | MEDIUM | OPEN | `investigation.rs run_lifecycle` result text | reproduced failure reads as "not verified; uncertain" | NO |
| NANI-020 | MEDIUM | OPEN (tracked) | `diagnosis.rs` hypothesis space | healthy-posterior artifact; contained by no-claim rule | NO |
| K-4 | LOW | OPEN | `AnalysisCompleted` payload | pre-verification snapshot; final truth on status card | NO |
| K-5 | LOW | OPEN | `NaniPage.tsx:645` "Confidence" label | raw posterior could be mistaken for calibrated | NO |
| K-6 | LOW | OPEN | oracle test | shares bridge/engine with production | NO |
| NANI-022 | LOW→raised | OPEN | engine units | see K-1 | via K-1 |

## 13. Required corrections (none blocking N1.2)

1. **K-1:** seconds conversion at the `commands/nani.rs` manual-check feed
   (coordinate with the concurrent author), then the NANI-022 unit contract.
2. **K-2:** move the cap check + `active.insert` into one critical section.
3. **K-3:** three-way verification prose (reproduced / refuted / unmeasured).
4. **NANI-021 (N1.3, first item):** `.no_proxy()` on the probe client + the
   tcp-failed/http-ok interception gate feeding Missing.

## 14. Final decision

**APPROVED WITH CONDITIONS.**

**N1.2 AUTHORIZED: YES.**

The diagnostic reasoning chain — real probe → bridge → engine → posterior →
targeted verification → updated posterior → verdict → events — is verified
end to end in committed code and reproduced tests, with exact-oracle evidence
and no ratio fallback. The conditions: land K-1/K-2/K-3 with the next commit
batch; execute NANI-021's `.no_proxy()` fix as the first item of N1.3, before
any diagnostic output is shipped to users in proxied environments. The
distinction the brief demanded is respected: as of this review, the
*committed* path computes correct posteriors from correctly-attributed
measurements; the *deployment environment* can still misattribute HTTP-layer
measurements (NANI-021), which is precisely why that fix leads N1.3.

*This review executed tests only; no source, reports, registry, or user work
was modified, and no processes or proxy settings were touched.*
