# Training a live batch — measured, with four defects it exposed

**Date:** 2026-11-06 · **Host:** this Windows workstation · **Vantage:** non-Iranian
**Server:** `apps/api` (tsx), data dir `tmp/smart-e2e`, port 8799, xray at `cores/xray.exe`
**Route:** `POST /api/v1/vpn/smart-connect/train` — the real route, the real database, real
proxy probes. Nothing injected.

This is the first run of the training path added earlier the same day. It was run to answer
one question — *is the model calibrated?* — and it answered four others first, each of which
was a real defect.

---

## 1. Catalogue and plan

699 public configurations from one feed (`MhdiTaheri`), imported 2026-11-04 and still in
`tmp/smart-e2e/netpulse.db`.

`GET /api/v1/vpn/smart-connect?limit=300` after the fixes below:

```
considered 300   candidates 98   excluded { "engine-rejects-config": 157, "stale": 45 }
```

157 of 300 configs are ones the installed core **cannot dial at all** — they are excluded
before a probe is spent. The number was 0 before this session.

| security (whole catalogue, 699) | count |
| --- | --- |
| `none` | 394 |
| `reality` | 145 |
| `tls` | 160 |

---

## 2. Batches

Ten batches, `size: 6, concurrency: 3` (one was capped at 2 by eligibility).

| # | attempted | verified | what the batch actually was |
| --- | --- | --- | --- |
| 1 | 6 | 0 | 6 × xray exit 23 — plaintext VLESS refused at startup |
| 2 | 6 | 0 | 5 × exit 23, 1 timeout |
| 3 | 6 | 0 | 6 × exit 23 (after the first prescreen, which exempted hostnames) |
| 4 | 2 | 0 | only 2 eligible in a size×6 slice; timeout + ECONNRESET |
| 5 | 6 | 0 | real dials: 5 timeouts, 1 reset |
| 6 | 6 | 0 | real dials: timeouts |
| 7 | 6 | 1 | **first verified tunnel** (HTTP 200 through xray) |
| 8 | 6 | 1 | verified; first stored predictions |
| 9 | 6 | 1 | verified; predictions context-scoped |
| 10 | 6 | 1 | verified; `calibrationBefore` non-null after a restart |
| **56** | **4** | 7.1 % of 56 attempts carried traffic |

At most 3 dials were in flight at any time. Batch wall time: 24.6 s when most candidates died
at startup, 48.5–49 s once they were real dials (6 probes / 3 lanes against a 12 s probe
timeout). The rank order, not the finish order, chose the winner.

The 4 verified successes are genuine: `status: done`, `httpStatus 200`, through the local
xray core, to the configured test target.

### Per-engine

| engine | attempted | verified |
| --- | --- | --- |
| xray | 56 | 4 |

Only xray is installed on this machine, so no cross-engine comparison is possible. That is a
property of the host, not of the model.

---

## 3. Calibration — the point of the run

`GET /api/v1/agent/permissions` → `training.calibration`, after batch 10:

```json
{ "samples": 12, "brier": 0.146, "baselineBrier": 0.25,
  "skill": 0.104, "meanPredicted": 0.25, "observedRate": 0.167 }
```

- **Brier 0.146** against **0.25** for always saying 0.5 → **skill +0.104**.
- The model's mean prediction was **0.25**; reality was **0.167** — it is slightly
  overconfident, by 0.083, on this corpus.
- 12 samples is **not** statistically meaningful. It says the scoring path works and the
  sign is positive; it does not say the model is better than a coin flip in general.

Predictions are stored per observation only when the engine's confidence for that context is
not `none`, so `predicted: null` means "the model declined to predict", which is excluded
from scoring rather than credited at 0.5.

---

## 4. Four defects the live run found

None of these were visible in the unit suite; each needed a real catalogue or a real restart.

**1. The plan dialled configs the core refuses (157/300).**
A plaintext VLESS node makes xray exit 23 at startup: *"vless without TLS or other encryption
is prohibited unless the server address is a private IP or domain"*. The first prescreen
exempted hostnames; five of six probes then died the same way, and the rejected node
(`b88d521b`) turned out to be `security: none` on a **hostname**. The rejection happens on
domains too, so the rule is now VLESS-only and host-independent (VMess keeps `none`, which is
legitimate and was never observed failing).
`smartConnect.ts: engineRejectsConfig`, 3 tests.

**2. A REALITY row with no public key built as plaintext.**
Node `0e7a187b` stores `security: reality` with `reality_public_key: null`; the builder emitted
`security: "none"` and the core refused it. 64 more rows like it were in the top 300.
Rejected now in two places: `engineSupportsConfig` (before a core is spawned, so the error
names the missing key) and the plan prescreen (so no probe is spent).
`proxyCores.ts` + 1 test, `smartConnect.ts` + 1 test.

**3. Strategy ids are `xray+doh`, not `xray:doh`.**
`engineProbabilities` split on `':'`, so the map key was `"xray+doh"` and every lookup for
`xray` missed. Consequence: the ±8 ranking nudge never applied to a real node, and no
prediction was ever stored — 41 observations, 0 predictions. Fixed with
`engineOfStrategy` (split on `+` or `:`, plus a known-engine check) and a test that a `xray+doh` entry
now moves the score.

**4. Predictions were dropped on load.**
`parseAdaptiveState` rebuilt observations without `predicted`, so calibration survived only
inside one process: `calibrationBefore` came back `null` after a restart with six scored
samples on disk. Fixed in `packages/shared/src/adaptive/policy.ts` with a round-trip test;
verified live — after a restart the endpoint reports the same 6-sample calibration.

Two smaller ones: the training queue only looked at `size×6` ranked candidates (top-of-ranking
is where undialable configs collect — 2 of 6 eligible), now `size×20` with the shortfall
stated in `note`; and a fully stale top-of-ranking made `train()` return `attempted: 0`
forever, because training could not re-measure the nodes it most needed to (now
`plan({ allowStale: true })` for training only — connecting still refuses stale evidence, and a
node that only ever failed is never retried).

---

## 5. What is still not measured

- **Iranian vantage:** `NOT TESTED`. Every number here is from one non-Iranian network.
- **Cross-engine:** only xray installed. sing-box/v2ray comparisons: `NOT TESTED`.
- **Significance:** 12 scored samples. Direction only.
- **Throughput:** `NOT MEASURED` — a probe asserts HTTP 200, not bandwidth.
- **Node-record classification:** a config the core refuses is still written to that node as a
  failed test (`updateNodeAfterTest` does not read `failureKind`), so the node drifts toward
  "failing" for a reason that is about the core. It no longer matters for ranking (the node is
  excluded first), but the node's own history is misleading. **Known defect, not fixed.**
