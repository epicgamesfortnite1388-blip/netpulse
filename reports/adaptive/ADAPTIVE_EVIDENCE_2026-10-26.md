# Adaptive connectivity intelligence — evidence report

**Mission:** `NETPULSE_ADAPTIVE_INTELLIGENCE`
**Date:** 2026-10-26, extended 2026-10-27 with the live VPS-corpus measurement **and a field measurement on a real Iranian access network (AS16322, Tehran)**, and 2026-10-28 with a **DNS-leak measurement while a tunnel was up (§8)**, a **second temporal field vantage (§9)**, and the **elevated re-run of the field arm after its UAC path was verified (§2)** · **Build:** local working tree (`main`, uncommitted) · **Deployed:** NO

This report states what was implemented, what was measured, and what was **not**
measured. A build that compiles is not evidence of connectivity, and a policy
that ranks correctly is not evidence that the app connects better: the two are
reported separately below.

---

## 1. What was built

| Piece | Where | What it does |
| --- | --- | --- |
| Policy core (pure, dependency-free) | [packages/shared/src/adaptive/](../../packages/shared/src/adaptive/) | learning state, decay, contextual-bandit ranking, exploration ceilings, failure classifier, signed-manifest verification, research-candidate registry |
| Engine service | [apps/api/src/services/adaptiveEngine.ts](../../apps/api/src/services/adaptiveEngine.ts) | approved-strategy discovery from the **installed** cores + the tunnel's own compatibility predicates, decide/observe/status/reset, manifest install/rollback, persistence in the local settings table |
| Trust anchor | [apps/api/src/services/adaptiveManifestTrust.ts](../../apps/api/src/services/adaptiveManifestTrust.ts) | real Ed25519 detached-signature verification against a pinned key id |
| Connect-path integration | [apps/api/src/services/autoConnect.ts](../../apps/api/src/services/autoConnect.ts) | `quickConnectCore` asks the engine for the order, dials with it, records **verified** outcomes (only an exit IP read through the tunnel counts), bounded to 2 engines per node |
| API surface | [apps/api/src/routes/adaptive.ts](../../apps/api/src/routes/adaptive.ts) | `GET /adaptive/status`, `GET /adaptive/plan` (dry-run with per-position explanations), `POST /adaptive/reset`, `GET/POST /adaptive/policy`, `POST /adaptive/policy/rollback` |
| UI | [apps/web/src/features/vpn/AdaptiveRecoveryCard.tsx](../../apps/web/src/features/vpn/AdaptiveRecoveryCard.tsx) | learned strategies with sample counts, "not usable for this node" reasons, why-each-position, the two switches, one-click **clear local learning data**, policy version + rollback; mounted in the VPN shell |
| Evaluation harness | [scripts/bench-adaptive-replay.ts](../../scripts/bench-adaptive-replay.ts) | measures a real corpus through the app's own proxy probe, then replays baseline vs adaptive using the **shipped** policy, walk-forward |

Design boundaries that the code enforces (not just documents):

- The engine may only **reorder cores that are installed and that the tunnel's
  own `engineSupports` / `engineSupportsConfig` predicates accept for this node**.
  It cannot add a core, a node, a hostname, or a credential.
- A strategy revoked by a signed policy update is out of the approved set even
  with local evidence that it works.
- `observe()` is fed the tunnel's verification result; `state === 'active'`
  without a verified exit IP is recorded as a **failure**.
- No failure, however repeated, is recorded as censorship. A hint requires
  failures at a common stage from **≥3 distinct strategies** and still reads
  "pattern, not a diagnosis".

## 2. Verification actually run

| Check | Command | Result |
| --- | --- | --- |
| Policy / classifier / candidate registry | `npx vitest run --root packages/shared test/adaptive*.test.ts` | **57 passed** |
| Engine decisions, signed manifests, real Ed25519 round trip | `npx vitest run --root apps/api test/adaptiveEngine.test.ts` | **24 passed** |
| Real connect path (engine → `quickConnectCore` → dial) | `npx vitest run --root apps/api test/adaptiveConnect.test.ts` | **6 passed** (incl. the cooling-off fallback)
| Existing connect-path suites still green | `test/vpnPreferences.test.ts`, `test/app.test.ts` | **33 passed** |
| DNS / routing / leak behaviour (criterion 7) | `npx vitest run --root apps/api test/killSwitch.test.ts test/egressThroughProxy.test.ts test/socksEgress.test.ts` and `… test/nodeEndpointLeak.test.ts test/cloudEgressRoute.test.ts test/dnsRecommendation.test.ts` | **86 passed** across the six pre-existing suites: kill-switch 29, SOCKS egress 11, egress-through-proxy 5, node-endpoint leak 22, cloud-egress route 7, DNS recommendation 12 |
| Policy resource cost (criterion 11) | `NODE_OPTIONS=--expose-gc npx tsx scripts/bench-adaptive-cost.ts` | at the maximum state the policy can hold (256 entries = 32 contexts × 8 strategies, 200 observations, 79 481 B persisted): `rankStrategies` **p50 4.0 / p95 6.8 µs**, `applyObservation` **54.9 / 70.7 µs**, startup decode **320 / 444 µs**, **120 KiB** retained heap, 0 network calls — evidence in [ADAPTIVE_COST.json](ADAPTIVE_COST.json) |
| Typechecks | `tsc --noEmit` in `apps/api` and `apps/web` | clean |
| Real-core corpus + replay | `SOURCE=live NODES_FILE=… npx tsx scripts/bench-adaptive-replay.ts` | 24 real attempts, 12 comparable episodes — evidence in [REPLAY_LIVE_REALITY.json](REPLAY_LIVE_REALITY.json) |
| Live VPS corpus + replay (`2026-10-27`) | `SOURCE=live NODES_FILE=/tmp/vps-corpus.txt npx tsx scripts/bench-adaptive-replay.ts` | 36 real attempts over 15 nodes, 15 comparable episodes — evidence in [REPLAY_LIVE.json](REPLAY_LIVE.json) |
| **Iranian access-network field run** + replay (`2026-10-27`) | `npm run field:iran` — one command: bypass up, corpus probe, replay, routing restored, evidence filed (§7) | 36 real attempts over the same 15 nodes, 15 comparable episodes, egress proven AS16322 Tehran — evidence in [REPLAY_LIVE_IR_ISP.json](REPLAY_LIVE_IR_ISP.json) and [REPLAY_LIVE_IR_ISP_RUN2.json](REPLAY_LIVE_IR_ISP_RUN2.json) |
| **Elevated field re-run** (`2026-10-28T1947Z`) | `npm run field:iran` with UAC approved — add → verify → replay → restore, against the finished wrapper | 36 real attempts, 15 episodes, `PASS`; raw egress `46.167.134.165 loc=IR`; both `/32` routes **absent** after restore — [REPLAY_LIVE_IR_ISP_2026-10-28T1947Z.json](REPLAY_LIVE_IR_ISP_2026-10-28T1947Z.json), [RAW_PATH_IR_ISP_2026-10-28T1947Z.txt](RAW_PATH_IR_ISP_2026-10-28T1947Z.txt) |
| Same-hour tunnel control (`2026-10-27`) | `npm run field:iran:control` — the same pipeline, no routing change | 36 real attempts over the same 15 nodes, 15 comparable episodes; repeated as `control-6` and `control-7` while verifying the wrapper, both 80% — evidence in [REPLAY_LIVE_TUNNEL_CONTROL.json](REPLAY_LIVE_TUNNEL_CONTROL.json) and [REPLAY_LIVE_TUNNEL_CONTROL_control-7.json](REPLAY_LIVE_TUNNEL_CONTROL_control-7.json) |
| **Second vantage in time**: same ISP, same tunnel, evening (`2026-10-28`) | `npm run field:iran:control -- -Tag evening-2026-10-28` | 36 real attempts, 15 comparable episodes, `PASS`; 66.7% reached a working core vs 80% in the 13:17Z control — 6 of 33 pairs flipped. A second **ISP/city** vantage is `BLOCKED` (§9) — evidence in [REPLAY_LIVE_TUNNEL_CONTROL_evening-2026-10-28.json](REPLAY_LIVE_TUNNEL_CONTROL_evening-2026-10-28.json) |

### The corpus that was measured

A real `xray-core 26.3.27` server was started locally (VLESS + REALITY +
XTLS-Vision), and the app's **own** probe path (`proxyProbeWithEngine`) was run
against it with the machine's real cores — `xray`, `sing-box`, `v2ray` — one
attempt per (node, core), 12 repeated episodes, fetching `https://httpbin.org/ip`
through the tunnel:

- `xray`: 12/12 carried real traffic (892–1130 ms)
- `sing-box`: 12/12 carried real traffic (949–1027 ms)
- `v2ray`: not offered by the app's own compatibility predicate for a REALITY
  node, so no attempt was recorded for it (the app never hands it that node)

Replay (budget 2 attempts, exactly what `quickConnectCore` grants):

| metric | baseline (fixed order) | adaptive |
| --- | --- | --- |
| comparable episodes | 12 | 12 |
| reached a working core | 100.0% | 100.0% |
| worked on the FIRST core tried | 100.0% | 100.0% |
| mean attempts per episode | 1.00 | 1.00 |
| p50 / p95 ms to a working core | 933 / 1045 | 933 / 1045 |
| attempts spent on a core that never worked | 0 | 0 |

**Reading:** parity, on a corpus that carries traffic. The adaptive order
reached a working core exactly as often and exactly as fast as the fixed order —
i.e. **no regression**, which is the property that lets it ship enabled.

### The live VPS corpus (2026-10-27)

The local corpus could not separate the two policies, because every core carried
traffic. The VPS corpus is the opposite case: the node links served by the
project's staging host, measured with the machine's real cores through the app's
own probe path (8 s timeout, endpoint `https://httpbin.org/ip`):

- 15 nodes in the corpus (vless, trojan, hysteria2, vmess), 36 attempts recorded
- `xray`: **0 / 15** carried traffic — every attempt "probe timed out"
- `sing-box`: **0 / 12** carried traffic (one of them a config rejection)
- `v2ray`: **8 / 9** carried real traffic (1273–7012 ms)

Replay (budget 2 attempts, exactly what `quickConnectCore` grants):

| metric | baseline (fixed order) | adaptive |
| --- | --- | --- |
| comparable episodes | 15 | 15 |
| reached a working core | 0.0% | **33.3%** |
| worked on the FIRST core tried | 0.0% | 33.3% |
| mean attempts per episode | 1.60 | 1.27 |
| p50 / p95 ms to a working core | n/a | 1701 / 7012 |
| attempts spent on a core that never worked | 24 | 14 |

First-core choice differed from the fixed order in **6 of 15** episodes; the
adaptive order won the first attempt where the baseline did not on **5**, and
lost an attempt the baseline won on **0**.

**Reading:** a real improvement on this corpus — the fixed order never reached a
working core (its first choices `xray` then `sing-box` carry no traffic on this
host), while the adaptive order reached one in a third of the episodes, always on
the first core it dialled. The mechanism matters as much as the number: the
policy had learned `xray`/`sing-box` fail here, and the **fallback** rule — added
*because of this corpus* (defect 4 below) — stops it repeating those known-broken
cores until the budget is gone. Two live repeats of this measurement gave 6/15
and 5/15; a replay reproduces neither variance nor the network.

### The Iranian access-network corpus (2026-10-27) — the field measurement

Every number above left the machine through the user's own Happ/sing-box tunnel
(exit `83.229.87.141`, AS204548 Kamatera, Frankfurt), so none of it said anything
about an Iranian access network. For the field measurement the same corpus was
re-measured with the app's probes routed **through the ISP itself**: two
`ActiveStore`-only /32 routes (the corpus host and one IP echo, via the LAN
gateway) made exactly the probe dials leave through the physical adapter, while
the tunnel kept owning `0.0.0.0/0` for everything else — the tunnel was never
disabled, and the routes were deleted straight after the runs. Method and
reversal: [rawpath-bypass.ps1](../../scripts/rawpath-bypass.ps1); raw evidence:
[RAW_PATH_IR_ISP.txt](RAW_PATH_IR_ISP.txt).

The vantage those routes expose (two independent checks agree):

| check | value |
| --- | --- |
| raw egress, Cloudflare trace on `1.1.1.1` | `ip=46.167.134.165`, `loc=IR` |
| holder of that address (ipinfo) | **AS16322 Parsan Lin Co. PJS, Tehran, IR** |
| control egress through the user's tunnel | `83.229.87.141`, AS204548 Kamatera, DE |

Same 15-link corpus, same knobs as the recorded run (one attempt per (node,
core), endpoint `https://httpbin.org/ip`, 8 s timeout, replay budget 2),
measured three more times inside ten minutes:

| arm | when (UTC) | egress | xray | sing-box | v2ray |
| --- | --- | --- | --- | --- | --- |
| recorded ([REPLAY_LIVE.json](REPLAY_LIVE.json)) | 2026-10-26 22:03 | tunnel → FRA | 0/15 | 0/12 | 8/9 |
| field run 1 ([REPLAY_LIVE_IR_ISP.json](REPLAY_LIVE_IR_ISP.json)) | 2026-10-27 13:10 | **raw ISP** | 8/15 | 8/12 | 6/9 |
| field run 2 ([REPLAY_LIVE_IR_ISP_RUN2.json](REPLAY_LIVE_IR_ISP_RUN2.json)) | 13:12 | **raw ISP** | 13/15 | 9/12 | 8/9 |
| same-hour control ([REPLAY_LIVE_TUNNEL_CONTROL.json](REPLAY_LIVE_TUNNEL_CONTROL.json)) | 13:17 | tunnel → FRA | 13/15 | 8/12 | 8/9 |

Replay over those outcomes (budget 2, the shipped policy):

| metric | field run 1 (13:10Z) | field run 2 (13:12Z) |
| --- | --- | --- |
| comparable episodes | 15 | 15 |
| baseline reached a working core | 53.3% | 66.7% |
| adaptive reached a working core | 53.3% | 66.7% |
| baseline worked on the FIRST core tried | 40.0% | 66.7% |
| adaptive worked on the FIRST core tried | **46.7%** | 66.7% |
| baseline / adaptive mean attempts | 1.20 / 1.13 | 1.00 / 1.00 |
| baseline / adaptive attempts spent on a core that never worked | 8 / 7 | 3 / 3 |
| baseline / adaptive p50 ms to a working core | 1381 / 1381 | 874 / 874 |
| baseline / adaptive p95 ms to a working core | 12926 / 12926 | 5924 / 5924 |
| adaptive won / lost a first attempt | 1 / 0 | 0 / 0 |

**Reading.** On this ISP the fixed order reached a working core on 53–67% of
episodes; the adaptive order never did worse (verdict **PASS** in both runs), and
in run 1 it converted one first attempt the fixed order lost — 40.0% → 46.7%
first-try, wasted attempts 8 → 7, zero losses — with the fallback rule from
defect 4 doing the work on a real Iranian path. The edge is small because on this
ISP the baseline's first core (`xray`) usually works: 12 of 15 episodes start on
`xray`, and the adaptive order agreed with the fixed one in 13/15 episodes in run
2 and in the control. That is the honest shape of the field result: **no
regression, plus a small measured gain when the path is in a bad state**.

**Two findings the field run added, reported rather than smoothed over:**

- This ISP filters **intermittently per port**, not by a fixed rule: at 13:07Z a
  6 s TCP connect to `206.1.96.89:2053` did not complete while 443, 2087 and
  8443 answered; at 13:15:47Z the reverse (`443` no answer within 5 s, `2053`
  open in 69 ms). The probe attempts show the same instability — the identical
  corpus took `xray` from 8/15 to 13/15 two minutes apart.
- The recorded corpus's `xray 0/15` **did not reproduce** on either path: the
  core that carried nothing at 22:03 carried traffic on 8/15 (run 1) and 13/15
  (run 2) through the ISP, and on 13/15 through the tunnel in the same hour. The
  0/15 was a property of that path at that hour, exactly as the earlier caveat
  warned — so the improvement quoted for it above must be read as
  corpus-specific, not as a standing advantage.

**What this does not establish.** One ISP (AS16322, Tehran), one LAN host, one
corpus that is a single remote server, ten minutes of one day — and the tunnel
arm is not the ISP path, so the 80% control figure says "this corpus works better
through Germany", not that either path is better in general. No claim is made
here about Iranian access networks as a population, other cities or ISPs, IPv6,
or censorship resistance.

### The elevated re-run (2026-10-28 19:47Z) — the field arm after its UAC path was verified

The 13:10Z and 13:12Z field runs were produced by this script, but the elevated
branch itself had not been exercised again after the wrapper's final fixes; §7
said so. This run closes that gap. UAC was approved, the script ran elevated, and
it filed the same three artifacts.

| step | evidence |
| --- | --- |
| bypass | both `/32` routes present via `192.168.1.1` (ifIndex 6); default routes untouched |
| raw vantage | `ip=46.167.134.165`, `loc=IR` (Cloudflare trace on `1.1.1.1`) |
| raw holder lookup | **unavailable this run** — `curl` exit 7, recorded; the address is the same one resolved to AS16322 Parsan Lin on 2026-10-27 |
| tunnel read before/after | unavailable (`curl` exit 7); the post-restore probe through the default path returned `ip=83.229.87.141 loc=DE` (the tunnel) |
| corpus | 15/15 nodes, 36 attempts: xray 12/15, sing-box 9/12, v2ray 6/9 |
| reachability | before: 443 open in 5 852 ms, 2053/2087/8443 open in 40–43 ms; after: **all five probes refused** — the per-port rotation seen on this ISP again |
| replay | baseline 11/15 (73.3%), adaptive 11/15 (73.3%), first-try 73.3% both, mean 1.00, p50 764 ms, p95 7 354 ms, 4 wasted attempts, 0 first-choice differences, 0 wins / 0 losses, `PASS` |
| restore | both routes removed and reported `absent`; an independent post-run `Get-NetRoute` for the two targets returned no rows; marker removed; default-path probe `83.229.87.141` DE |

Filed: [REPLAY_LIVE_IR_ISP_2026-10-28T1947Z.json](REPLAY_LIVE_IR_ISP_2026-10-28T1947Z.json),
its `.log`, and [RAW_PATH_IR_ISP_2026-10-28T1947Z.txt](RAW_PATH_IR_ISP_2026-10-28T1947Z.txt).

**Reading.** This is a third field vantage in time on the same ISP, and it is
plain parity: the adaptive order agreed with the fixed order in all 15 episodes
and reached the same 11 working cores. It is useful as a wrapper proof and as
another repeat, not as evidence of superiority. It also illustrates the
environment the policy exists for: the same endpoints answered at the start of
the run and refused minutes later.

**What this does not establish.** Same ISP, same LAN host, same single-server
corpus. The holder lookup that independently proves AS16322 failed this run; the
raw trace only proves the egress address and `loc=IR`. The tunnel-egress reads
before and after also failed, so the restore proof rests on the route table (both
`/32` targets absent) plus the post-restore default-path address returning to
`83.229.87.141`, not on a successful pre-run inequality check.

## 3. Acceptance criteria, stated honestly

| # | Criterion | Verdict | Evidence / why |
| --- | --- | --- | --- |
| 1 | The real client uses the engine | **PASS** | `quickConnectCore` calls `adaptive.plan()` and dials with the returned order; asserted by `adaptiveConnect.test.ts` (first dialled core changes after learning) |
| 2 | Selects among multiple compatible, approved strategies | **PASS** | engine test: order ⊆ {installed ∧ compatible ∧ not revoked}; integration test dials two real cores |
| 3 | Uses observed outcomes to improve decisions | **PASS** | engine test: preferred core flips after verified outcomes; integration test: dialled engine flips; replay walks forward with no look-ahead |
| 4 | Works with no external LLM | **PASS** | the policy is pure arithmetic in `@netpulse/shared`; the engine makes no network call of any kind |
| 5 | Failures classified without assuming DPI | **PASS** | `adaptiveEngine.test.ts`: DNS / authentication / engine-unavailable / not-verified classes; `dpiInferred: false` asserted; hint needs 3 distinct strategies |
| 6 | A working tunnel ≠ a completed handshake | **PASS** | integration test: an `active` state with no verified exit IP is recorded as failure and `quick.ok === false` |
| 7 | DNS and routing behaviour tested | **PASS** | DNS **classification** is tested (`dns-resolution-failed`, DNS context bucket) and the DNS-through-tunnel flag is part of a strategy id. Routing, endpoint-leak and DNS-behaviour suites were **re-run and green**: `killSwitch` (29), `socksEgress` (11), `egressThroughProxy` (5), `nodeEndpointLeak` (22), `cloudEgressRoute` (7), `dnsRecommendation` (12) — **86 tests, 0 failed** (§2) |
| 8 | Untrusted configurations cannot auto-activate | **PASS** | candidate-registry tests refuse promotion without provenance, license, review and a controlled test; the engine can only reorder installed cores, so an Internet configuration has no path to activation |
| 9 | Updates authenticated, versioned, reversible | **PASS** | signed-envelope tests: `key-mismatch`, `signature-invalid` (including post-signing edits), `not-yet-valid`, `expired`, `not-newer`, `channel-refused`, `incompatible-app`, `incompatible-state`, clamping, revocation, rollback |
| 10 | Subscription/credential controls intact | **PASS (by construction + asserted)** | the engine reads no credential and writes none; the corpus used the real vault path; no new endpoint returns a secret |
| 11 | Privacy and resource consumption measured | **PASS (measured, not only bounded)** | privacy is structural (local settings key, counts/timings only, no addresses, no destinations, reset endpoint + UI action). Resource cost measured at the policy's maximum state (32 contexts × 8 strategies = 256 entries — the registry cannot produce the 12/context the cap allows — and 200 stored observations, 79 481 B persisted): `rankStrategies` p50 **4.0 µs** / p95 6.8 µs, `applyObservation` p50 **54.9 µs** / p95 70.7 µs, startup decode p50 320 µs / p95 444 µs, retained heap **120 KiB** after a forced GC, +27 B per observation at the cap (the row is rewritten per attempt), **0 network calls** — [ADAPTIVE_COST.json](ADAPTIVE_COST.json) via [bench-adaptive-cost.ts](../../scripts/bench-adaptive-cost.ts) |
| 12 | Adaptive beats or meaningfully improves on baseline | **PASS — measured on a real Iranian access network (replay), no regression** | Field (AS16322 Tehran, raw ISP path, 2026-10-27): the fixed order reached a working core on 8/15 (53.3%) and 10/15 (66.7%) episodes in two runs minutes apart; the adaptive order matched both and in run 1 won one first attempt the baseline lost (40.0% → 46.7% first-try, wasted attempts 8 → 7, 0 losses). Same-hour control through the tunnel: 12/15 (80%) for both, 0 losses. Recorded VPS corpus: 0/15 vs 5/15 (33.3%), 0 losses. Local corpus: 12/12 both. All are replays over real core measurements; §2 and §5 state which arm used which egress path, and what the sample cannot support |
| 13 | Report with evidence, limits, deployment status | **PASS** | this file |
| 14 | UI section + clearing local learning data | **PASS (typechecked only)** | `AdaptiveRecoveryCard` mounted in the VPN shell; **no visual/browser run was performed** |

## 4. Defects found and fixed during this work

1. **Baseline-order mistranslation (real bug, caught by the new engine test).**
   `plan()` received the caller's *engine* order but ranked against *strategy
   ids* (`xray+doh`). Every strategy missed the baseline lookup, so with no
   evidence the order fell to the alphabetical tie-break — `sing-box → xray` —
   breaking the "a fresh install behaves exactly as before" guarantee. Fixed by
   translating in one place, with the same DNS-through-tunnel flag the strategies
   are built with.
2. **No same-node fallback after a failed attempt.** If the learned core failed,
   the node was abandoned for discovery even when a second approved core was
   installed. `quickConnectCore` now tries the next approved core (still capped
   at two per node, never a sweep). Found by the integration test, which then
   covered it.
3. **A metric that flattered the wrong party.** The replay's "wasted attempts"
   counter initially counted every first attempt on a node with no history. It
   now counts attempts on a (node, core) pair the corpus proves never works.
4. **A learned dead-end the policy could not escape (found by the live VPS
   corpus).** When every strategy with enough evidence is cooling off after
   consecutive failures, ranking put those known-broken cores first and spent the
   whole 2-attempt budget on them, so the working core (`v2ray`) was never
   reached — 0/15 for both policies. Fixed with a **fallback, not exploration**:
   when all trusted strategies are cooling, the first non-cooling approved
   strategy is dialled first. It is deliberately *not* gated on the exploration
   opt-in (this is recovery, not evidence gathering), it is bounded to one
   candidate in exactly that state, and it never invents a candidate — it
   reorders what the caller already approved. Asserted end-to-end in
   `adaptiveConnect.test.ts`.

## 5. Limitations (read before quoting any number)

- The replay is a **counterfactual over recorded outcomes**: it cannot
  reproduce the network, run-to-run flakiness, or what else the machine was
  doing. Each outcome was measured once.
- The live VPS corpus is **one staging host** (15 node links served by it), not a
  population of subscribers' networks, and two live repeats of the same
  measurement gave 6/15 and 5/15 — the variance a replay cannot show.
- `xray`/`sing-box` failing 27/27 attempts is a measurement of *that host's
  path*, not a claim about those cores in general.
- The measured corpus is **one endpoint, repeated 12 times** (a repeatability
  corpus, not 12 distinct public nodes). The public node sample in the app's own
  database failed to carry traffic in every attempt during this run.
- An episode is excluded when the corpus has no outcome for the core a policy
  wants to try; a replay must not invent measurements.
- `packages/shared` reports **57** adaptive tests; the API reports **63** across the four adaptive suites, plus **86** across the six pre-existing DNS/routing/leak suites re-run for criterion 7. The full repository suite was **not** run.
- The resource numbers in §2 come from a Node harness on this machine, not from the packaged desktop build or a phone, and they time the policy functions rather than the whole application; heap is measured after a forced GC (`--expose-gc`).
- Exploration (deliberately trying a strategy that is not expected to win) is
  **off by default** and was off in every measurement above.
- The field measurement used **one ISP** (AS16322 Parsan Lin, Tehran) from **one
  LAN host**, inside ten minutes of one day: a first field datapoint, not a
  population. Nothing here measures another city or ISP, mobile vs fixed-line,
  IPv6, time-of-day effects, or a subscriber's end-to-end install.
- The raw-path arms came from **bypassing the user's own tunnel with two host
  routes** (§2), so the measured path is the ISP's, but the run excluded the
  app's own system-proxy/DNS/kill-switch wiring — it probes the ISP, it does not
  reproduce a subscriber session.
- The three same-day arms differ by more than the path (13:10, 13:12, 13:17Z)
  and the ISP's per-port filtering rotated inside that window; small n and one
  shot per (node, core) still apply, as does the replay's own caveat.
- The field advantage is **bounded by the corpus**: on this ISP the baseline's
  first core usually worked, so both policies agreed in 13 of 15 episodes in run
  2 and in the control. The measured difference appeared only while the path was
  degraded (run 1).
- The recorded corpus's `xray 0/15` / `sing-box 0/12` **did not reproduce** on
  either path the next day (§2), so no claim should be built on that split alone.

## 6. Deployment status and next steps

**Not deployed.** Adaptive ordering is enabled by default (safe because no
evidence reproduces the previous order exactly — now asserted), exploration is
opt-in, policy updates require a signing key that this build does not ship, and
the UI exposes the off switch and the reset.

The 2026-10-27 field measurement (§2) is the first time this harness ran against
a real Iranian access network (AS16322, Tehran) instead of an already-tunnelled
path: the verdict there is **no regression plus one captured first-attempt win**,
and the same-hour control shows the corpus itself is easier through the tunnel
(80% vs 53–67%). To become a product claim it needs **more vantage points** —
other ISPs and cities, ideally subscriber installs rather than a host-route
bypass, repeats across the day, and a corpus that is not a single server —
because this ISP's per-port blocking rotates and two runs minutes apart already
differ by 13 points. The measurement is now an experiment with a method, not a
code change, and it is one command (§7).

## 7. Reproducing it in one command

The whole experiment is [field-iran-isp.ps1](../../scripts/field-iran-isp.ps1),
wrapped by four npm scripts. The route targets are **derived from the corpus**
(`scripts/rawpath-hosts.mjs` prints host:port only — no share link, secret or
password ever reaches the transcript), never pasted from a previous run.

| Command | What it does | Evidence it files (in `reports/adaptive/`) |
| --- | --- | --- |
| `npm run field:iran:plan` | prints the resolved `/32` targets, the port probes and every step; changes nothing, no elevation | nothing |
| `npm run field:iran` | raises UAC, adds the ActiveStore `/32` routes (corpus host + the `1.1.1.1` vantage echo), verifies each one and that the default route is untouched, **requires** the raw egress to differ from the tunnel's when that read is available, looks the raw address's holder up separately, probes reachability before and after, runs the corpus through the app's own probe path, replays baseline vs adaptive, then deletes exactly the routes it added | `REPLAY_LIVE_IR_ISP_<tag>.json` / `.log`, `RAW_PATH_IR_ISP_<tag>.txt` |
| `npm run field:iran:control` | the same corpus and replay through the tunnel, no routing change, no elevation | `REPLAY_LIVE_TUNNEL_CONTROL_<tag>.*` |
| `npm run field:iran:recover` | deletes a bypass left by an interrupted run, from the marker the `add` wrote; needs elevation | nothing |

The restore is in a `finally`, so a failed or interrupted run still removes the
routes; `rawpath-bypass.ps1 -Action add` refuses to start while a marker from an
earlier run exists, and `-Action status` prints, read-only, whether anything is
in place.

Verification status of the wrapper itself (`2026-10-27`, after it was finished):

- `field:iran:control` ran end to end — preflight, corpus, live replay, restore
  check, all three evidence files filed, `PASS on this corpus` with 15/15
  comparable episodes at 80%/80% ([control-7](RAW_PATH_TUNNEL_CONTROL_control-7.txt)).
  Two independent same-hour controls now agree at 80%.
- Defects found by running it, all fixed: the runner aborted the whole
  measurement on a transient *vantage read* (now recorded evidence, not a gate);
  PowerShell 5.1 turned a native command's stderr into a terminating error and
  then rendered it as `NativeCommandError` decoration in the filed transcript
  (now the child's line, verbatim and UTF-8); and the field arm's route targets
  omitted the `1.1.1.1` vantage echo, which would have made every field run fail
  its own probing of the vantage — caught in plan mode, before any run.
- **The elevated field arm is now verified end to end (2026-10-28T1947Z).** UAC
  was approved; the run added both `/32` routes, proved the raw vantage, filed 36
  attempts over 15 nodes (`PASS`), then removed the routes, confirmed both
  `absent`, removed the marker, and watched the default path return to the tunnel
  (`83.229.87.141`). Evidence:
  [REPLAY_LIVE_IR_ISP_2026-10-28T1947Z.json](REPLAY_LIVE_IR_ISP_2026-10-28T1947Z.json),
  [RAW_PATH_IR_ISP_2026-10-28T1947Z.txt](RAW_PATH_IR_ISP_2026-10-28T1947Z.txt). The
  only reads that failed were the independent tunnel/holder lookups (`curl` exit
  7), recorded as such instead of dropped.

## 8. DNS leak measurement while a tunnel is up (2026-10-28)

**Question:** while a tunnel is up on this Iranian access network, do DNS
queries leave the machine through a non-tunnel interface?

**Method** ([measure-dns-leak.ps1](../../scripts/measure-dns-leak.ps1), read-only,
no elevation, no route or resolver change):

1. identify the tunnel interface from the address the OS actually egresses as
   (Cloudflare trace) and the route to it;
2. for every **configured** IPv4 resolver, ask `Find-NetRoute` which interface a
   datagram to that resolver uses — the same decision the DNS client makes;
3. query each resolver for `whoami.akamai.net` (A-record echo, returns the
   resolver's own egress address) and record whether it answered;
4. classify: answered **and** routed off-tunnel = leak; answered **and** routed
   through the tunnel = no leak; off-tunnel but silent = unreachable, not a leak;
5. record the **fail-open surface** — public resolvers configured on physical
   adapters, which are harmless while the tunnel owns the route and become
   raw-path queries if it stops doing so.

TXT echo (`o-o.myaddr.l.google.com`) was the first choice and was abandoned for
a measured reason: on this path **every plaintext TXT answer came back empty**
(including `cloudflare.com TXT` via `1.1.1.1` and via the tunnel resolver
`172.19.0.2`), while the same name over DoH through the tunnel returned a valid
record. That is a property of the path worth knowing, but it makes TXT useless
as a leak witness here; the A-record echo does answer and was used instead.

**Environment measured:** Windows host on the same access network, with a live
xray TUN present as the `happ-xray` interface (ifIndex 18, not started by this
workspace) holding the default route; egress `83.229.87.141` (DE, colo FRA). **This is not NetPulse's
own tunnel** — the workspace holds no node or credential that could bring one
up (the app's `public_nodes` tables in both local databases are empty, and the
VPS client credential is not in the tree), so the app's tunnel was not the
subject of this run.

| resolver | configured on | route interface | answered | resolver echo | verdict |
| --- | --- | --- | --- | --- | --- |
| 1.0.0.1 | physical adapters | happ-xray | yes | 172.71.140.37 | answered through tunnel path |
| 1.1.1.1 | physical adapters | happ-xray | yes | 172.71.140.37 | answered through tunnel path |
| 172.19.0.2 | happ-xray | happ-xray | yes | 172.71.140.37 | answered through tunnel path |
| 192.168.1.1 | Ethernet | Ethernet | **no** (timeout) | — | off-tunnel, unreachable |

System resolution of `example.com` succeeded through the same path (a Cloudflare
address; the exact answer rotates between runs and is recorded in the JSON), so
DNS was working, not merely failing closed.

**Result: `NO LEAK OBSERVED`** — every resolver that answered routes through the
tunnel interface, and the one configured off-tunnel resolver (the LAN router)
did not answer at all. Evidence: [dns_leak_ir_isp-tunnel-up.json](dns_leak_ir_isp-tunnel-up.json)
and [dns_leak_ir_isp-tunnel-up.md](dns_leak_ir_isp-tunnel-up.md).

**What this does not prove, stated plainly:**

- **No packet capture.** The classification is the routing decision, not an
  observed packet (capture needs administrator rights, which this run did not
  take). A tunnel that captures by rule rather than by route would not be seen
  here; this one owns the default route, so route membership is the right test.
- **Fail-open risk is real and measured, not hypothetical.** `1.1.1.1`,
  `1.0.0.1` and `192.168.1.1` are configured on physical adapters
  (`failOpenSurface`). While the tunnel route exists they are tunneled; the
  moment it disappears those same resolvers are raw-path queries. Whether the
  client fails closed on tunnel drop was **not tested** — dropping the tunnel
  would have cut the user's live connectivity, which this measurement was not
  authorised to do.
- **One network, one moment, one client.** Same caveat as §5: this is a single
  vantage on a single ISP, and an external xray TUN, not the product's. It says
  nothing about NetPulse's own tunnel, and nothing about its TUN gateway
  ([tunGatewayHandle.ts](../../apps/api/src/services/tunGatewayHandle.ts)),
  which is a different code path that was not brought up in this run.

**Reproduce:** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-dns-leak.ps1 -Tag <tag>`
while a tunnel is up; it writes `dns_leak_ir_isp-<tag>.{json,md}` next to this
report and exits 0 whether or not a leak was found (the verdict is in the
output), 2 only when it cannot measure at all.

## 9. Second field vantage (2026-10-28)

**Status of the requested vantage: `BLOCKED` — a different Iranian ISP or city.**

The measurement host has exactly one upstream: Ethernet `192.168.1.2` via
`192.168.1.1` (AS16322). Wi-Fi, Bluetooth PAN, three TAP/WireSock adapters and
the Happ TUN were checked; every non-Ethernet adapter is either disconnected or
link-local, and no LTE/mobile tether or second Iranian host is authorised or
reachable from here. A second ISP/city vantage is a network prerequisite, not
something code can supply, and nothing below pretends otherwise.

### What was collected instead: a second vantage in TIME, same ISP

The corpus was re-measured 5 h 35 min after the 13:17Z control, over the same
tunnel path, with no routing change:

```
npm run field:iran:control -- -Tag evening-2026-10-28
```

Filed: [REPLAY_LIVE_TUNNEL_CONTROL_evening-2026-10-28.json](REPLAY_LIVE_TUNNEL_CONTROL_evening-2026-10-28.json),
its log, and [RAW_PATH_TUNNEL_CONTROL_evening-2026-10-28.txt](RAW_PATH_TUNNEL_CONTROL_evening-2026-10-28.txt).
36 recorded attempts, 15 comparable episodes, `PASS` on the corpus
(66.7% reached a working core; p50 739 ms, p95 8 824 ms; 4 wasted attempts).

The run's own vantage read (`ipinfo.io` through the tunnel) failed with curl
exit 7 at that moment and is recorded as such in the transcript — the corpus
probes themselves succeeded, so the run was kept rather than discarded, and the
failed read is not quietly dropped.

### Comparison tooling (new)

[compare-field-vantages.mjs](../../scripts/compare-field-vantages.mjs),
wrapped as `npm run field:compare`. It diffs any two filed field evidences and
refuses to overclaim:

- **per-pair flips** keyed by corpus id + core (the node label alone repeats in
  this corpus, so the id is printed beside it);
- **agreement** — how much of the corpus behaves identically, which is the
  baseline any "difference" claim must beat;
- **adaptive aggregates** side by side (episode success, first choice, mean
  attempts, p50/p95, wasted attempts, wins/losses);
- **comparison kind** derived from the files, not from the caller: same arm =
  repeatability, different arm = path comparison, different corpus = "not
  directly comparable";
- it states that a flip is not proof of filtering, every time.

### Comparison 1 — same arm, same tunnel, 13:17Z vs 18:52Z (repeatability)

| metric | 13:17Z | 18:52Z | delta |
| --- | --- | --- | --- |
| attempts ok | 29/36 | 29/36 | 0 |
| episodes | 15 | 15 | 0 |
| reached a working core | 80.0% | 66.7% | **-13.3 pts** |
| worked on first core | 66.7% | 60.0% | -6.7 pts |
| mean attempts | 1.13 | 1.07 | -0.06 |
| p50 / p95 to working | 903 / 9 246 ms | 739 / 8 824 ms | -164 / -422 ms |
| wasted attempts | 5 | 4 | -1 |
| pair agreement | — | **27/33 = 81.8%**, 6 flips (2 worked only at 13:17Z, 4 only at 18:52Z) | — |

Evidence: [COMPARE_REPLAY_LIVE_TUNNEL_CONTROL_vs_REPLAY_LIVE_TUNNEL_CONTROL_evening-2026-10-28.md](COMPARE_REPLAY_LIVE_TUNNEL_CONTROL_vs_REPLAY_LIVE_TUNNEL_CONTROL_evening-2026-10-28.md).

**Why this matters for the request:** on the *same* network, the *same* exit and
the *same* corpus, 6 of 33 pairs flipped and episode success moved 13.3 points
within one afternoon. Any cross-ISP difference smaller than that band cannot be
attributed to the ISP without repeat runs; a second vantage must therefore be
sampled more than once, and the first comparison against AS16322 should be read
as a hypothesis, not a finding.

### Comparison 2 — raw ISP path vs tunnel path, same hour (path, not ISP)

| metric | raw path (13:10Z) | via tunnel (13:17Z) | delta |
| --- | --- | --- | --- |
| attempts ok | 22/36 | 29/36 | +7 |
| reached a working core | 53.3% | 80.0% | +26.7 pts |
| p50 / p95 to working | 1 381 / 12 926 ms | 903 / 9 246 ms | -478 / -3 680 ms |
| pair agreement | — | 25/33 = 75.8%, 8 flips (2 raw-only, 6 tunnel-only) | — |

Evidence: [COMPARE_REPLAY_LIVE_IR_ISP_vs_REPLAY_LIVE_TUNNEL_CONTROL.md](COMPARE_REPLAY_LIVE_IR_ISP_vs_REPLAY_LIVE_TUNNEL_CONTROL.md).
This is what the **path** changes on this ISP at that hour. It is not a second
ISP: the same access network, the same corpus, the same hour.

### Collecting the missing vantage when a second network exists

On a host attached to the other ISP/city, with the same corpus file:

```
npm run field:iran -- -Tag <city>-<isp>            # raw-path arm (needs elevation)
npm run field:iran:control -- -Tag <city>-<isp>    # tunnel control (no elevation)
npm run field:compare -- --a reports/adaptive/REPLAY_LIVE_IR_ISP.json \
                          --b reports/adaptive/REPLAY_LIVE_IR_ISP_<city>-<isp>.json
```

Run each arm **at least three times across the day** (morning/afternoon/evening)
before drawing any cross-ISP conclusion — the 13-point same-network swing above
is the floor of what one afternoon can do. The tooling, evidence naming and the
comparison are in place; only the second network is missing.

**Limits of everything in this section:** one host, one corpus (a single server
on four ports), 36 attempts per run, counterfactual replay over recorded
outcomes. No cause is claimed for any flip, and no Iranian network other than
AS16322 was measured.
