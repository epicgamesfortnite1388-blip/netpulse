# Smart Connect Design

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Implementation:** `apps/api/src/services/smartConnect.ts` (new), routes in `apps/api/src/routes/vpn.ts`
**Tests:** `apps/api/test/smartConnect.test.ts` — **22 passing**
**Live proof:** `reports/accounting/SMART_CONNECT_LIVE_2026-11-04.md` — verified a real node end-to-end

---

## 1. Why this layer exists

Before this change the app could:

- discover and store public nodes,
- test a node on demand (`POST /api/v1/nodes/:id/test`),
- recommend nodes by preset (`GET /api/v1/nodes/recommend`),
- connect through a profile,

but nothing turned "which of 34,150 discovered links should I dial, and why" into a decision with evidence, bounded dialling, and a place for learning. `recommend` is a query; it does not verify and it does not record what it learned. Smart Connect is that missing orchestrator.

It has three responsibilities, and deliberately no others:

1. **Rank** stored candidates on evidence (no sockets).
2. **Verify** the best few with a bounded probe that must carry traffic.
3. **Learn** from the probe result through the existing adaptive engine.

It does **not** connect. Establishing a tunnel to a third-party endpoint requires the user to accept the privacy warning, so the caller receives a decision plus the exact next calls.

---

## 2. Pipeline

```
GET  /api/v1/vpn/smart-connect      ──▶ plan()
                                        │
   public_nodes (DB) ──▶ exclusion ──▶ scoring ──▶ ranking ──▶ decision
                                        │                      │
                                        │              no sockets opened
                                        ▼
POST /api/v1/vpn/smart-connect      ──▶ verify({ maxProbes ≤ 10, concurrency ≤ 3 })
                                        │
                    plan() ──▶ probe top-N through a bounded pool
                                        │
                     nodes.testNode(id,'proxy')  ── traffic must traverse
                                        │
                        verified? ──▶ chosen + next steps
                             │
                        no  ──▶ chosen = null, "stay disconnected"
                                        │
                                        ▼
                        adaptive.observe({ ok, timeToWorkingMs })
```

---

## 3. Stage A — exclusion (with counted reasons)

A candidate is removed — and **counted** so the UI can explain an empty list — when:

| Reason | Rule | Why |
| --- | --- | --- |
| `revoked` | `status ∈ {revoked, blocked}` | Explicitly withdrawn |
| `failed` | `consecutiveFailures >= 3` or `status ∈ {failed, dead}` | Repeatedly dead; do not burn probes |
| `stale` | `freshness = expired`, **or evidence older than 24 h**, or tests exist but none succeeded | Evidence too old to act on |
| `abandoned` | `now - lastSeen > 7 days` | Vanished from every feed |

Note on `stale`: it is computed from `lastSuccessAt` / `lastValidated`, **not** from the stored `freshness` column. Live runs showed that column saying `stale` for a node that had just passed a 580 ms probe, and also for every freshly imported node. Using it directly caused two false exclusions.
| `no-engine-installed` | protocol is supported by *some* known core, none installed | Machine limitation, not a bad config |
| `unsupported-protocol` | no known core speaks it (e.g. `http`) | Config limitation |

The last two being distinct matters: "install sing-box to use this" and "this app cannot use this" are different messages, and conflating them teaches users the wrong thing.

---

## 4. Stage B — ranking

```
score = 0.30·reliability + 0.24·latency + 0.16·freshness
      + 0.16·evidence    + 0.08·sources  + adaptiveBoost + failurePenalty
```

| Component | Range | Definition |
| --- | --- | --- |
| `reliability` | 0–100 | Stored `reliabilityPct` (success ratio over the node's tests) |
| `latency` | 0–100 | 100 at ≤150 ms, 0 at ≥3 s, linear between; uses median proxy, else last proxy, else TCP |
| `freshness` | 0–100 | 15 min → 100, 1 h → 85, 6 h → 65, 24 h → 40, 3 d → 20, older → 5 |
| `evidence` | 0–100 | Recency of last verified success ×0.8 plus `log2(1+successes)·12` capped at 25 |
| `sources` | 0–100 | `min(sourceCount,5)/5 · 100` — independent republishing is weak corroboration |
| `adaptiveBoost` | ±8 | `(p_success − 0.5) · 16 · confidenceWeight`, from the adaptive engine |
| `failurePenalty` | 0 to −30 | `−6 × consecutiveFailures` |

### The evidence caps

```
if confidence === 'untested'            → score = min(score, 55)
if no proxy success on record            → score = min(score, 70)
```

The second cap exists because a TCP handshake is not a tunnel. Live data: a node with a 15 ms TCP success scored **93** and displaced the node that had just carried HTTP at 580 ms. Port-only evidence still beats untested, but it can no longer impersonate traffic verification.

A row that has never carried verified traffic **cannot outrank the tested band**, regardless of its stored metadata. `confidence` is:

- `verified` — a proxy success within `VERIFIED_WINDOW` (2 h) with a measured latency,
- `tested` — some past success, but older than the window,
- `untested` — no success on record.

Ties break by confidence, then by smaller evidence age. A dead node falls in rank automatically as `lastSuccessAt` ages and `consecutiveFailures` rises.

---

## 4a. Prescreening: configs the core refuses

A rank is not a connection, and a probe is not free. Some public configs cannot be
dialled by the installed core **at all**, and that is knowable before any socket
opens. Two rules, both measured on xray 26.10.31 against the live catalogue:

| Config | What the core does | Excluded as |
| --- | --- | --- |
| VLESS, `security: none` (any host) | exits 23 at startup: *"vless without TLS or other encryption is prohibited…"* | `engine-rejects-config` |
| `security: reality` with no public key | builds a plaintext outbound, then exits 23 | `engine-rejects-config` |

On the 699-node feed, **157 of the top 300** ranked rows are excluded this way
(93 plaintext VLESS + 64 keyless REALITY) and never cost a probe. VMess with
`security: none` stays eligible — it carries its own encryption and was never
observed failing — and sing-box is not covered by the rule because that rejection
was never seen on it. The rule encodes measurements, not opinions.

The second rule also lives in `engineSupportsConfig`, so any path that starts a
core (test, scan, tunnel) gets `"…cannot build REALITY without the node's public
key"` instead of an exit code.

---

## 4b. Training a batch — the counterpart to verification

`POST /api/v1/vpn/smart-connect/train` with `{ size ≤ 10, concurrency ≤ 3 }`.

| | Verify | Train |
| --- | --- | --- |
| Question | "is there a working endpoint?" | "what does the model learn from these?" |
| Stops at first success | yes | **no** |
| Returns a chosen candidate | yes | no (attempts + per-engine counts + calibration) |
| Learns from failures | only those dialled before the hit | every attempt in the batch |
| Charges `network:verify-traffic` | `maxProbes` reserved, unused released | `size` reserved, unused released |
| Source pool | ranked candidates only | ranked + **time-stale** rows (`allowStale`), never a node that only ever failed |

Both share one pool (`probePool`), so the concurrency ceiling, the refill rule
and the rank-order winner cannot drift apart. Each observation is stamped with
the probability the engine had assigned to that engine under the current
context, which is what makes `calibration.skill` meaningful rather than a count.

Polling for a result: there is no background job — the request returns when the
batch has settled, because the batch is capped at 10 probes × the 12 s probe
timeout. Measured: 24.6 s for a batch whose candidates died at startup, 48.5 s
for six real dials at three lanes.

Training reads a wider slice (`size × 20`, minimum 200) than verification, because
the top of the ranking is where undialable and stale rows collect: a `size × 6`
slice produced 2 eligible candidates out of 6 requested. When fewer candidates
exist than asked for, the response says so in `note` rather than silently dialling
less.

Measured on 2026-11-06: 56 dials across ten batches, 4 verified (7.1 %), Brier
0.146 vs a 0.25 baseline, skill **+0.104** on 12 scored samples. The test suite
covers the numbers; the run is in `reports/accounting/TRAINING_LIVE_2026-11-06.md`.

---

## 5. Stage C — bounded verification

- `maxProbes` is clamped to **1–10** (matching the `network:verify-traffic` per-call cap) and `concurrency` to **1–3** cores. Probes run through a bounded worker pool: a slot is refilled while nothing has verified, and no new dial is launched once a candidate succeeds — in-flight attempts drain, their evidence is kept, and `probesRun` reports exactly how many were dialled.
- The pool may therefore dial up to `concurrency` candidates even when the first one succeeds. That cost is deliberate: a probe is mostly waiting (core start + handshake), so lanes overlap that wait against the same dial budget, which is what lets the adaptive engine accumulate real evidence at a useful rate. **The wall-clock gain on real endpoints is NOT MEASURED** — what is tested is the mechanism (max in-flight, refill rules, rank-order winner), not a speedup. Rank order still decides the winner, not finish order.
- Each probe spawns its own core on its own reserved ephemeral port in its own temp dir (`proxyCores.startCore`), so concurrent attempts cannot collide on a port or a config file.
- The probe is `ctx.services.nodes.testNode(nodeId, 'proxy')` — the same persisted path the node explorer uses, which:
  - spawns a real local core through `proxyProbeWithEngine()`,
  - reaches `done` only when the request through the proxy returned a response,
  - writes a `node_tests` row and updates the node's counters.
- **Verification rule:** `status === 'done'` **and** engine recorded **and** `200 ≤ httpStatus < 400`. A `502` through a broken tunnel is a failure, not a success.
- Every attempt is fed to `adaptive.observe()` with `ok` and `timeToWorkingMs`; a throw inside learning is swallowed so it can never fail the request.
- A thrown probe is converted into a failed candidate with the error attached, not a 500.

This is why the result carries `probesRun` and `verified` separately: "we tried 3 and none worked" is a different, more useful statement than "no candidates".

---

## 6. API

### `GET /api/v1/vpn/smart-connect?limit=300`

Returns `SmartPlan`:

```jsonc
{
  "generatedAt": 1793...,
  "considered": 412,
  "excluded": [{ "nodeId": "…", "reason": "stale" }],
  "excludedByReason": { "stale": 208, "failed": 61, "no-engine-installed": 12 },
  "candidates": [{
    "nodeId": "…", "protocol": "vmess", "engine": "xray",
    "score": 71, "confidence": "verified", "trust": "TRAFFIC_VERIFIED",
    "components": { "reliability": 83, "latency": 76, "freshness": 100,
                    "evidence": 88, "sources": 40,
                    "adaptiveBoost": 2.1, "failurePenalty": 0 },
    "reasons": ["reliability 83% over 6 tests", "latency evidence 344 ms", "…"],
    "probe": null
  }],
  "chosen": { "…": "…" },
  "decision": "Verified: node … (vmess over xray), score 71/100. This is a selection, not a connection.",
  "adaptive": { "available": true, "enabled": true, "context": "…", "engineProbabilities": [ … ] },
  "limits": ["A stored score is historical…", "The operator of a free public endpoint is unknown…"]
}
```

### `POST /api/v1/vpn/smart-connect` `{ maxProbes?: 1..5, limit?: 1..500 }`

Same shape plus `probesRun`, `verified`, and (only when verified):

```jsonc
"next": {
  "createProfile": "POST /api/v1/vpn/profiles/from-node {\"nodeId\":\"…\"}",
  "connect": "POST /api/v1/vpn/connect {\"profileId\":\"<created profile id>\"}",
  "note": "Connecting a third-party endpoint needs the user to accept the privacy warning first."
}
```

Rate limited to 6/minute. Every call records an event with the outcome and probe count — never a link, address or credential.

---

## 7. Trust ladder

`SmartCandidate.trust` uses the mission's categories, derived from evidence — never from "it looked fine":

| Category | Condition |
| --- | --- |
| `REVOKED` | status revoked/blocked |
| `FAILED` | ≥3 consecutive failures, or failed/dead status |
| `STALE` | freshness stale/expired |
| `RECENTLY_RELIABLE` | success ≤6 h, reliability ≥80%, ≥3 successes |
| `TRAFFIC_VERIFIED` | proxy success ≤2 h with latency recorded |
| `CONNECTION_TESTED` | any test/validation on record |
| `STATICALLY_VALIDATED` | parses and a core supports it |
| `PUBLIC_UNVERIFIED` | none of the above |

A successful probe is time-stamped (`probe.at`) and ages out; it is never permanent trust.

---

## 8. Adaptive integration (how the AI changes a decision)

- The plan applies a **±8 point** adjustment from the adaptive engine's Beta posterior success probability per engine, weighted by confidence (`high 1.0`, `medium 0.75`, `low 0.5`), and never for `confidence: 'none'`.
- The engine choice that gets verified is the one recorded, so the next ranking reflects *this machine's* experience.
- If the adaptive layer throws, the plan still returns with `adaptive.note` explaining the fallback. Learning is a nudge, never a gate.

Bound and rationale: eight points can reorder close candidates but cannot lift an untested row over the cap, cannot rescue a failing node, and cannot override a large reliability gap. That is intentional — see `ADAPTIVE_AI_REPORT.md` for the measured cost and the replay result.

---

## 9. Test coverage

`apps/api/test/smartConnect.test.ts` (40 tests) asserts, among others:

- revoked / failing / stale / unsupported rows are excluded **with counted reasons**;
- training probes the whole batch (failures included), stops at the probe ceiling, and stamps each observation with the model's probability — including storing `null` when the model had no confident view;
- the verification pool holds at most `concurrency` probes in flight, clamps a request for 10 lanes down to 3, refills only while nothing has verified, launches nothing after a hit, and prefers rank order over finish order when several probes succeed;
- "no engine installed" is distinguished from "protocol unsupported";
- an untested row is never `verified` and is capped at 55;
- fresh verified evidence beats a higher stored score with no evidence;
- the adaptive nudge is ≤8 points and does not change the winner when evidence is clearly better;
- a throwing adaptive layer degrades gracefully;
- probing stops at the first success; failures fall through to the next candidate;
- an out-of-band HTTP status is **not** verified;
- all-fail returns `chosen: null` with a stay-disconnected decision;
- the probe budget is respected;
- a thrown probe becomes a failed attempt, not an exception;
- a freshly imported, never-tested row (stored as `freshness: 'stale'`) stays eligible and is badged `STATICALLY_VALIDATED`, not `STALE`;
- a just-verified row whose stale flag was never cleared stays eligible and is `verified`;
- TCP-only evidence is capped at 70 and ranks below a traffic-verified node.

---

## 10. Limits

- Ranking quality is bounded by evidence quality: 5.9% of sampled public configs carried traffic, so a healthy plan will often have only a handful of real candidates.
- No measured throughput gain from the pool: the concurrency bound and scheduling rules are tested, the reduction in time-to-verification on live endpoints is not, and no multiplier is claimed.
- Concurrency is capped at 3 for a reason: each probe is a separate engine process, and the ceiling bounds both local resource use and the load a single user can put on third-party endpoints. Ten probes at the 12 s worst case is ~2 min sequential, ~40 s if three lanes always overlap that wait (arithmetic, not measured); the UI must show progress.
- Smart Connect does not auto-connect. Automatic reconnection for a chosen third-party endpoint is a separate, explicitly authorised feature.
- Iran-ISP behaviour remains unmeasured; a "verified" candidate on this vantage is not a promise for that one.

---

## 11. Live run summary (2026-11-04)

| Step | Result |
| --- | --- |
| Import one feed | 699 stored, 437 duplicates, 863 invalid, 3.5 s |
| Plan | 300 candidates in **43 ms** |
| Verify (first) | **2 probes**: vless rejected by xray (code 23), then Shadowsocks **HTTP 200 / 580 ms** → verified in **931 ms** |
| Persistence | `node_tests` proxy rows written; node `test_count 1`, `last_proxy_ms 580`, `status healthy`; adaptive state 1 success + 1 failure |
| Verify (second, after fixes) | **1 probe**, 628 ms, verified in **1,043 ms**; verified node ranked #1 at 89, port-only capped at 70 |

Full artifact: `reports/accounting/SMART_CONNECT_LIVE_2026-11-04.md`.
