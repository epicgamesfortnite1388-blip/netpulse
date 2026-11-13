# Adaptive AI Report

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Implementation:** `packages/shared/src/adaptive/policy.ts` (policy), `apps/api/src/services/adaptiveEngine.ts` (host), `apps/api/src/services/smartConnect.ts` (new consumer)
**Verdict:** the local AI is **real, deterministic, bounded, offline, and measurably changes connection decisions**. Its measured advantage is **large on a censored corpus (0/15 → 5/15)** and **small but non-negative on a raw ISP path (1 win / 0 losses)**. It is not a neural network and no such claim is made.

---

## 1. What it is allowed to decide

The adaptive engine chooses **which already-installed, already-compatible local core to prefer** for the next attempt — and, since this evaluation, contributes a bounded nudge to public-node ranking.

It cannot:

- add an engine, node, host or credential,
- modify a configuration,
- disable TLS verification or the kill switch,
- convert a research idea into a running strategy.

The candidate set is derived from the machine (`findEngineBinary`) plus the same `engineSupports` / `engineSupportsConfig` predicates the tunnel uses. There is no second opinion about compatibility.

---

## 2. Algorithm — deterministic contextual bandit

| Element | Implementation |
| --- | --- |
| Evidence | Success/failure counts per `(context, strategy)` |
| Recency | Exponential decay, **half-life 14 days** |
| Probability | **Beta posterior**: `α = 1 + successes`, `β = 1 + failures`, `p = α/(α+β)` |
| Ranking value | **lower confidence bound**, not the mean: `lb = p − 2·sqrt(p(1−p)/(n+2))` (Beta(1,1) prior included) |
| Cost term | `score = lb − 0.25 · clamp(meanSuccessMs / 8000, 0, 1)` |
| Exploration | **UCB-shaped bonus** `sqrt(ln(1 + totalEvidence) / (1 + evidence))`; untried strategies get infinite bonus and fall back to baseline order |
| Trust gate | Reordering requires `evidence ≥ minSamples (5)`; below that, the fixed baseline order is kept |
| Cooling | `flopThreshold = 3` consecutive failures marks a strategy cooling |
| Bounds | 32 contexts × 12 strategies, 200 observations, state ~79 KB serialized |
| Randomness | **None.** Deterministic by design, so tests can assert exact behaviour |

Why no neural network: with a handful of cores and a handful of contexts, a decayed Beta posterior with a cost term is interpretable, cheap (microseconds), and testable. A network would add opaque parameters, training data we do not have, and non-determinism, with no evidence it would improve a 2–4 arm decision.

---

## 3. What counts as an observation

`observe()` is fed only with a **verified** outcome — a tunnel that carried traffic (`ok: true`), or a classified failure. A spawned process is not a success. This is the same rule the integration report applies to "connected", and it is what keeps the posterior honest.

Failure classification (`classifyConnectFailure`) maps stage/reason to a small taxonomy, which is what the reports and UI display instead of a raw error string.

---

## 4. Policy updates and trust anchoring

- A policy manifest can adjust bounds (e.g. reduce exploration to zero) but **cannot force exploration on**.
- Manifests are signature-verified against a configured key id (`adaptivePolicyKeyId` / `adaptivePolicyPublicKey`); without a trusted anchor, unsigned manifests are refused.
- `POST /api/v1/adaptive/policy/rollback` reverts to the previous applied manifest.
- `POST /api/v1/adaptive/reset` clears learned state; it is the documented escape hatch.

---

## 5. Measured baseline vs adaptive

Harness: `scripts/bench-adaptive-replay.ts` — real corpus measured through the app's own proxy probe, then **walk-forward replay** of the shipped policy against a fixed-order baseline. Raw data and per-run notes in `reports/adaptive/`.

| Corpus / arm | Baseline reaches a working core | Adaptive reaches a working core | Wins / losses |
| --- | --- | --- | --- |
| Recorded censored corpus (VPS-era) | **0/15 (0%)** | **5/15 (33.3%)** | 5 / 0 |
| Field AS16322 Tehran, raw ISP path, run 1 | 8/15 (53.3%) | 8/15 (53.3%) | 1 / 0 — first-try 40.0% → 46.7%, wasted 8 → 7 |
| Field AS16322, same-hour control through tunnel | 12/15 (80%) | 12/15 (80%) | 0 / 0 |
| Local corpus | 12/12 | 12/12 | 0 / 0 |

Reading these honestly:

- The **big** effect appears exactly where a fixed order is wrong: when the first preferred core is blocked, the baseline never recovers within its budget, and learning finds a working one in a third of episodes. That is the case this feature exists for.
- Where the baseline already works (raw ISP, tunnel control, local), adaptive **matches** it and never loses an attempt. No regression was observed in any replay.
- The advantage is **bounded by corpus size and diversity**. Rows are 15-episode replays, not a statistically strong result, and no confidence interval is claimed.
- A "win" is a first-attempt difference in the replay, not proof of causation on a live network.

---

## 6. Cost (why it is safe to run on every connect)

`reports/adaptive/ADAPTIVE_COST.json` — 20,000 iterations at maximum state:

| Operation | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| `rankStrategies` | **4 µs** | 6.8 µs | 479.7 µs |
| `applyObservation` | **54.9 µs** | 70.7 µs | 844.5 µs |
| `parseAdaptiveState` | 320 µs | 443.7 µs | 3.6 ms |

State at bounds: 256 entries, 32 contexts, 200 observations, **79,481 bytes** serialized (310.5 B/entry), heap delta **123,000 B** (480.5 B/entry). An extra observation adds 27 bytes. This is negligible for a desktop client and works entirely offline.

---

## 7. New in this evaluation: the AI reaches public-node selection

Before this change the adaptive engine only reordered **cores** inside `quickConnectCore`. Now `SmartConnectService`:

1. reads per-engine learned probabilities from `adaptive.status()` and applies a **±8 point** nudge, weighted by confidence and skipped entirely for `confidence: 'none'`;
2. probes the ranked candidates through a bounded pool (at most 3 cores at once, default 2) and calls `adaptive.observe({ nodeId, engine, ok, timeToWorkingMs })` for **each** attempt — including attempts that finish after a winner is chosen;
3. treats learning as advisory: a throwing adaptive layer degrades the plan with an explanatory note instead of failing it.

So the local AI now influences **which endpoint is verified**, not just which core dials it. The nudge is capped so it cannot promote an untested row (55-point cap), cannot rescue a failing node, and cannot overturn a large reliability gap — all asserted in `apps/api/test/smartConnect.test.ts`.

**Effect size on public-node selection: NOT TESTED.** There is no live corpus yet of Smart Connect decisions with learning on vs off. The mechanism and bounds are tested; the benefit is not measured, and is not claimed.

---

## 8. The research agent

The mission also asks for an autonomous research/discovery process. What exists:

- a **scheduled source refresh** (`SourceRefreshScheduler`) with per-source intervals, conditional requests and bounded concurrency;
- a **source health** history (success/failure, reliability score, last fetch);
- a **research corpus** of findings (`docs/research/dpi/bibliography.md`, parsed by `missionOverdrive.ts` into the mission ledger);
- a dashboard that reads what was actually discovered, rejected, tested and chosen (`/api/v1/mission/overdrive`).

What does **not** exist, and is not claimed:

- an LLM-driven agent that rewrites source lists or invents new connection methods at runtime. New strategies require a code change and review (`packages/shared/src/adaptive/candidates.ts`).
- unrestricted shell/administrator access for any AI component. There is none.

Honest framing: the "autonomous" part is **scheduled, bounded measurement and discovery**, not unbounded self-modification. A network-level probe is expensive and third-party-harming if unbounded, so the loop is rate-limited by design.

---

## 9. Model review and the uncertainty change (2026-11-05)

### What the review found

The ranking compared strategies on the **posterior mean**. With fewer than five
observations a strategy is not eligible to be preferred, but between five and
many, a lucky run wins: `5/5` has a mean of 0.857 while `30/40` has 0.738, so
five attempts displaced forty. That is the same mistake the public-node ranking
had (a thin record outranking real evidence), one level down.

### What changed

| Change | Where |
| --- | --- |
| Ranking sorts on a one-sided lower bound (`uncertaintyZ = 2`) instead of the mean | `packages/shared/src/adaptive/policy.ts` → `lowerBoundOf` / `scoreOf` |
| Every decision exposes `lowerBound` alongside `successProbability`, so the UI can show the value the order actually used | `packages/shared/src/adaptive/types.ts` |
| `uncertaintyZ: 0` restores the old point-estimate behaviour exactly, so the two policies can be replayed against one corpus | policy option + `scripts/bench-adaptive-replay.ts` (`UNCERTAINTY_Z`) |
| The signed policy patch **cannot** change `uncertaintyZ` | `manifest.ts` has no field for it — a remote update may not switch the guard off |

### Measurement (same corpora, both policies)

| Corpus | Episodes | reached a working core (fixed → adaptive) | first-core wins | lost |
| --- | ---: | --- | ---: | ---: |
| `REPLAY_LIVE_IR_ISP` (censored) | 15 | 53.3% → 53.3% | 1 | 0 |
| `REPLAY_LIVE` (censored) | 15 | 0.0% → 33.3% | 5 | 0 |
| `REPLAY_LIVE_TUNNEL_CONTROL` (clean) | 15 | 80.0% → 80.0% | 0 | 0 |

With `UNCERTAINTY_Z=0` and `=2` every metric above is **identical**, episode for
episode, in all three corpora: the two artifacts of a pair differ only in the
`uncertaintyZ` field and the timestamp. All six were regenerated on 2026-11-06
from one build of the harness, and each pair is byte-identical after those two
fields are removed.

| Corpus | `z = 0` | `z = 2` |
| --- | --- | --- |
| `REPLAY_LIVE_IR_ISP` | `reports/adaptive/REPLAY_LCB_IR_ISP_z0.json` | `REPLAY_LCB_IR_ISP_z2.json` |
| `REPLAY_LIVE` | `reports/adaptive/REPLAY_LCB_LIVE_z0.json` | `REPLAY_LCB_LIVE_z2.json` |
| `REPLAY_LIVE_TUNNEL_CONTROL` | `REPLAY_LCB_TUNNEL_CONTROL_z0.json` | `REPLAY_LCB_TUNNEL_CONTROL_z2.json` |

Two things the reproduction taught, both recorded because they cost a wrong
result first:

- `SOURCE` selects the data source and `CORPUS_JSON` only supplies the corpus.
  Running `SOURCE=tunnel-control` against a corpus file silently replayed the
  local DB instead (1 episode, 0%), which briefly looked like a policy
  difference. Every artifact above was produced with `SOURCE=live`.
- `REPLAY_LIVE_IR_ISP` first-choice accuracy moves 40.0% → 46.7% under the
  adaptive policy (6/15 → 7/15 first cores correct) at unchanged overall
  success, which is the ranking doing its job on captured data.

**Honest conclusion: the change is a guard, not a measured improvement.** The
corpora do not contain an episode where a thin record had displaced a thick one,
so the two policies agree on every decision they cover. It ships because it
closes a known failure mode without changing behaviour on any evidence we have —
not because it made anything faster.

### Calibration and training (implemented 2026-11-06)

Counting successes is not evidence that the probabilities mean anything. Every
observation now records `predicted` — the probability the engine had assigned to
the strategy when it chose it — and `calibrationOf()` scores those:

| Metric | Definition |
| --- | --- |
| `brier` | mean `(predicted − outcome)²` over attempts that carried a prediction |
| `baselineBrier` | the same attempts scored by always predicting 0.5 |
| `skill` | `baselineBrier − brier`; positive means the model beat a coin flip, negative means it is confidently wrong |
| `meanPredicted` / `observedRate` | what it said versus what happened |

It is stored with the adaptive state, so it survives a restart. Attempts where
the engine had no confident view (`confidence: 'none'`) store `predicted: null`
and are **excluded** rather than credited at 0.5 — inventing a forecast to score
against would flatter the model.

**Training is an action, not a metaphor.** `POST /api/v1/vpn/smart-connect/train`
probes up to 10 candidates, at most 3 concurrently, and records **every** attempt
— failures included, because failures are the majority of public nodes. It
deliberately does not stop at the first success (that is what `verify` is for),
and it returns the calibration before and after the batch. It is charged against
the same hourly `network:verify-traffic` allowance, and whatever it reserves but
does not dial is released back.

**Measured calibration on this machine (2026-11-06).** Ten live training
batches, 56 real dials, 4 verified tunnels (7.1 %):

```json
{ "samples": 12, "brier": 0.146, "baselineBrier": 0.25,
  "skill": 0.104, "meanPredicted": 0.25, "observedRate": 0.167 }
```

Skill is **+0.104** over a coin flip, and the model was slightly overconfident
(it said 0.25, reality was 0.167). Twelve samples establishes that the scoring
path works and the sign is positive — **not** that the model is calibrated in
general. Full run: `reports/accounting/TRAINING_LIVE_2026-11-06.md`.

That run also found three defects in this section's own machinery, all fixed:
strategy ids are `xray+doh` (the code split on `:`, so no nudge and no prediction
had ever reached a real engine); `parseAdaptiveState` dropped `predicted` on
load, so calibration silently reset on every restart; and the training queue
read only the top `size×6` ranked rows, which are where undialable configs
collect, so eligibility was 2 of 6.

### Still not implemented, and not claimed

- **Hierarchical pooling across contexts.** Evidence from `tls failing` does not
  inform a fresh `dns failing` context; the engine deliberately falls back to the
  baseline order instead of borrowing. Pooling is the obvious next model step and
  is not built.

---

## 10. Limits

- Replay evidence plus one live training run on one non-Iranian network; not a
  live A/B on public nodes.
- Iran field runs exist as a harness and a corpus, but current-state Iran behaviour is **NOT TESTED**.
- The posterior is per-context and per-strategy; a context the machine has never seen correctly falls back to the baseline rather than guessing.
- The learned state is local and disposable — by design, it contains counts and timings only, no network or user identifiers.
