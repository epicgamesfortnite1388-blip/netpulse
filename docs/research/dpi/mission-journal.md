# Mission Journal â€” DPI Research and Engineering

Mission: `NETPULSE_DPI_RESEARCH_AND_ENGINEERING`
Started: 2026-10-25
State: **active, first evidence cycle complete; no Iran vantage.**
Extension (2026-10-26): the adaptive connectivity engine now consumes this
corpus. What it was allowed to conclude, and what it refuses to: failures are
classified as DNS / transport / authentication / server-outage / configuration /
local-network / not-verified, and **no single failure or repeat of one failure is
ever reported as censorship** — `censorshipHintOf` requires failures at a common
stage from at least three DIFFERENT strategies inside a short window, and even
then says "pattern, not a diagnosis". Evidence and verdicts:
`reports/adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md`.

## 1. Repository state at start

- `E:\Code\Project\Vpn_app`, branch `main`, HEAD `48c1794`.
- Large pre-existing uncommitted worktree (WhiteDNS API/UI, per-user VPN
  credentials, Cloudflare worker changes, reports). **Preserved; not
  reverted.**
- The prior `reports/research/DPI_CENSORSHIP_RESEARCH_2026-10-24.md` is a
  useful summary but cites fewer sources and does not include the live
  WhiteDNS test. This lab supersedes it for engineering decisions.
- Do not commit or push unless explicitly asked. This cycle did not.

## 2. Environment facts

- Windows dev host: active `happ-xray` TUN, default route ifIndex 58;
  direct HTTPS egress `83.229.87.141`; DNS to 1.1.1.1/8.8.8.8/9.9.9.9/VPS
  returns `AA=1`, no answers in 5-9 ms. Local DNS tests are invalid.
- VPS `206.1.96.89`: Soar panel 0.6.0, Soar v0.2.2, `soar-check 0.1.0`,
  UDP/TCP 53 public, panel loopback 12053.
- A working authorized SSH key was used from `~/.ssh`; its name and material
  are intentionally not recorded. Do not print keys or `VPS-KEYS.txt` contents.

## 3. Completed this cycle

| Item | Evidence |
|---|---|
| Read mandatory Iran sources and 30+ source registry | `bibliography.md` |
| Built layered threat model | `iran-censorship-threat-model.md` |
| Separated DNS/DoH/DoT/DoQ/DNS-tunnel concepts | `dns-circumvention-analysis.md` |
| Documented ECH limits | `tls-sni-ech-analysis.md` |
| Live Soar client test on VPS | UDP/TCP/auto HTTP 200; wrong key fails |
| Windows Soar client test | built from Soar v0.2.3; timed out due TUN/DNS block |
| Fixed WhiteDNS diagnostic false positive | AA + exact-zone NS/SOA (parent SOA labeled) |
| Added real TCP DNS query | `tcpQuery` with framing/matching ID |
| Fixed pubkey omission | env fallback `WHITEDNS_PUBKEY` |
| Added configurable diagnostic path | `WHITEDNS_SOAR_CHECK`; honest skip |
| Added proxy-aware TCP DNS | `tcpQuery` HTTP CONNECT + `WHITEDNS_PROXY` fallback |
| Windows client through local proxy | HTTP 200 in 3.4 s over TCP/53 via `127.0.0.1:10808` |
| Added regression tests | 16/16 `whitednsService`; API typecheck clean |
| Documented architecture/roadmap/security | this directory |

## 4. Test results

- `npm run test -w @netpulse/api -- whitednsService.test.ts`: 16 passed.
- `npm run test -w @netpulse/api`: 97 files, 1055 tests passed.
- `npm run typecheck -w @netpulse/api`: exit 0.
- `npm run lint`: exit 0; `npm run build -w @netpulse/api`: exit 0.
- VPS `soar-check`: `tcp=off`, `tcp=only`, `tcp=auto` all
  `ok:true handshake:true http_status:200`; wrong key
  `ok:false stage:tunnel handshake:false`.
- Windows direct client: `connect_failed=context deadline exceeded`, 90 s.
- Windows client via local Happ proxy (`127.0.0.1:10808`, SOCKS5, TCP/53
  only): `http_status=200 elapsed_ms=3442`.
- No production restart, no DNS record change, no panel change.

## 5. Next actions (highest value)

1. Decide the shipping Windows WhiteDNS client path. The proxy-capable Go
   client proves the protocol, but it is a lab binary; choose a pinned
   Windows build or an external CottenDNS/WhiteDNS Desktop workflow. Do not
   ship the temp binary or fake a NetPulse-connected state.
2. Rotate the exposed panel path with owner approval; keep it loopback-only.
3. Bind WhiteDNS profiles to D1 entitlements; test expiry/revocation.
4. Fix child-zone apex NS/SOA with the vendor/zone plan.
5. Run the 20-attempt matrix from a non-TUN vantage and, if possible, a
   voluntary Iranian vantage.
6. Evaluate a bounded transport selector offline before production.

## 6. Blockers

- No Iranian consumer-network vantage; no censorship-resistance claim.
- Windows DNS/TUN prevents local Soar validation; do not disable the user's
  VPN without consent.
- Panel path rotation and DNS record changes require production approval.
- CottenDNS aggregate/WhiteDNS Desktop licenses need review.
- FOCI 2026 PDF text was not extractable with the local toolchain.

## 7. Change control

- Code changes are limited to:
  `apps/api/src/providers/dns/codec.ts`,
  `apps/api/src/providers/dns/resolver.ts`,
  `apps/api/src/services/whitednsService.ts`,
  `apps/api/test/whitednsService.test.ts`.
- Research docs are new under `docs/research/dpi/`.
- No production change was made in this cycle.


## 8. Cycle 2026-11-03 — Mission Overdrive (evidence surface)

**Prompt:** review the roadmap and continue; then NETPULSE_OVERDRIVE_FINAL.

**What was built**
- `GET /api/v1/mission/overdrive` (`apps/api/src/services/missionOverdrive.ts`) — reads the
  measured artifacts under `reports/accounting/`, the 37-entry research registry and the
  Iran-ready section of `ROADMAP.md`, and classifies every row. Each artifact parses inside
  its own guard; a missing or corrupt file becomes an `unavailable` row naming the reason,
  never a zero.
- `/overdrive` (`apps/web/src/features/mission/OverdrivePage.tsx`) — six tabs: Overview
  (requirements + measured path + artifact timeline), Evidence, Research (filterable), Adaptive
  AI, Infrastructure (live ledger), Final report (verdicts from the report artifact).
- Motion is decoration over measured medians and is removed under `prefers-reduced-motion`
  (CSS media query plus `motion-reduce:hidden`). No progress bars, no synthetic values, no
  action buttons beyond re-reading.

**Findings recorded, not smoothed**
- Aether's SOCKS5 refuses hostname-form CONNECT (ATYP 0x03), so DNS resolves locally —
  **outside the tunnel**. `TUNNEL_STAGES_2026-11-03.json` shows DNS at 1 ms for that reason.
  Payload is tunnelled; names are not. This is now a roadmap limitation and a caveat on the
  dashboard row.
- Two research entries added and verified live: S36 Psiphon Tunnel Core (GitHub API, pushed
  2026-11-02, GPL-3.0) and S37 Tor anti-censorship / bridgestatus (GitLab API, 24 projects,
  last active 2026-10-16). The remembered `Psiphon-Inc` owner is a 404; `psiphon-labs` is canonical.

**Checks run**
- `npm test -w @netpulse/api` → 104 files, **1120 passed**, exit 0 (was 1113 + 7 new).
- `npm test -w @netpulse/web` → 51 files, **461 passed**, exit 0.
- `npm run typecheck` (api, web) clean; `npx eslint` on the six touched files clean; web build pass.
- The page was exercised in the running app: all six tabs render, keyboard tab switching works,
  and the Final report tab shows 19 verdicts.

**Not established**
- No Iranian vantage (0/5), no host access, no WhiteDNS zone, no payment credentials, and no
  production deployment. One-hour survival, IPv6 leak and reconnection remain untested.

---

## 2026-11-06 — agent permissions, an uncertainty guard in the ranking, and a full re-verification

**Added**
- `apps/api/src/services/ai-agent/permissions.ts`: capability catalogue in four tiers (always /
  budgeted / user-only / forbidden), hourly budgets, per-call ceilings, a pause that stops only
  unattended work, refusal-without-spending, an audit ring, and fail-closed handling when the
  policy cannot be read. Forbidden capabilities live in code: `exec:shell`, `exec:elevated`,
  `read:credential`, `write:settings`, `install:core`.
- Enforcement at three real action points — the scheduled probe batch (whole batch checked before
  the first dial), the scheduled feed refresh, and Smart Connect verification (429 with the
  remaining allowance before any candidate is dialled). `GET /api/v1/agent/permissions`,
  `POST /api/v1/agent/autonomy`, and an `AgentAutonomyCard` that renders only what that endpoint
  returns.
- Adaptive ranking now sorts on a one-sided lower confidence bound (`uncertaintyZ = 2`) instead of
  the posterior mean, and exposes `lowerBound` on every decision. `uncertaintyZ` is absent from the
  signed policy manifest, so a remote patch cannot disable the guard.
- Smart Connect verification runs through a bounded concurrent pool (`concurrency` 1–3, default 2;
  `maxProbes` raised to the policy's 10) instead of a strict sequence. A slot is refilled only while
  nothing has verified, in-flight attempts drain after a hit and keep their evidence, and the winner
  is still the highest-ranked verified candidate rather than the fastest. Each probe already owns a
  reserved ephemeral port and temp dir, so parallel attempts cannot collide.

**Checks run (this tree)**
- `npx vitest run` in `apps/api` → **107 files, 1,198 passed**, exit 0 (228.3 s).
- `apps/web` → 52 files, **472 passed**; `packages/shared` → 10 files, **136 passed** (1,806 total).
- `tsc --noEmit` exit 0 in api, shared and web; `eslint packages/shared/src apps/api/src apps/web/src`
  exit 0; `vite build` exit 0 (11.5 s).
- Replay of the LCB change, three corpora × both policies: identical episode-for-episode. Artifacts
  `reports/adaptive/REPLAY_LCB_{IR_ISP,LIVE,TUNNEL_CONTROL}_z{0,2}.json`.

**Defects found and fixed in this cycle**
- The route-wiring meta-test caught the new card fetching `/api/v1/api/v1/agent/...` (the client
  already prefixes `/api/v1`). Had it shipped, the card would have 404'd while typechecking clean.
- The scanner test asserted on a 5 s wall-clock window; under full-suite load a blackholed TCP probe
  outlasted it. The window is now 20 s and the assertion is about the job's outcome, not the clock.
- Two lint errors fixed at the cause: a values import used only as types (`tunnelDns.ts`) and a
  dead helper (`agentPath.ts`).
- Report arithmetic corrected against measurements: the suite figures (1,143 → 1,188, 106 → 107
  files), `aetherProvider` 20 → 19 tests, `aetherDns` 9 → 7, Smart Connect 16 → 22, README 973 →
  1,784, and the replay artifact list, which previously implied files that did not exist.

**Training, added later the same day**
- Every adaptive observation now records `predicted` — the probability the engine gave
  the strategy when it chose it — and `calibrationOf()` scores them as a Brier score with a
  0.5 baseline and a `skill` figure. Observations without a confident model view store
  `null` and are excluded, not credited at 0.5.
- `POST /api/v1/vpn/smart-connect/train { size ≤ 10, concurrency ≤ 3 }` probes a batch and
  learns from **every** attempt, failures included; `verify` still stops at the first
  success. Both share one pool and one hourly allowance (unused reservation is released).
- `GET /api/v1/agent/permissions` now reports `training.calibration`, and the autonomy card
  shows the skill score plus a Train action.
- **First live training: 2026-11-06, ten batches, 56 dials, 4 verified (7.1 %).**
  Calibration after the last batch: 12 samples, Brier 0.146 against a 0.25 baseline,
  **skill +0.104**, mean predicted 0.25 against an observed rate of 0.167 — right sign,
  slightly overconfident, and far too few samples to be called calibrated.
  `reports/accounting/TRAINING_LIVE_2026-11-06.md`.
- The live run found four defects no unit test could: the plan dialled configs xray refuses
  (plaintext VLESS, and REALITY without a public key — 157 of the top 300 rows), training
  could never re-measure a stale node, strategy ids are `xray+doh` so the `:` split meant the
  nudge and the prediction never reached an engine, and `parseAdaptiveState` dropped
  `predicted` so calibration reset on every restart. All four are fixed and tested.

**Both decision cards rendered, and covered by a test**
- Ran the API on 8787 against the trained database and the web app on 5173, opened
  `/vpn` → Proxy Tunnel. Live values: 300 considered, 70 candidates, 230 excluded
  (`refused by the installed core: 178`, stale 41, repeatedly failing 11); autonomy
  card 12/60 probes, 5 denied, calibration skill 0.104 (Brier 0.146 vs 0.25).
  Screenshots: `reports/screenshots/vpn-smart-connect.png`, `vpn-agent-autonomy.png`.
- The `engine-rejects-config` exclusion printed as a raw enum, so the badge now says
  "refused by the installed core".
- Both cards' bodies were extracted into `SmartConnectBody` / `AutonomyBody` (the
  fetching wrappers keep the state) so `renderToStaticMarkup` can assert the real
  markup without adding testing-library: 11 tests, including that "verified" appears
  only where a probe carried traffic and that an unmeasured calibration prints `—`
  rather than `0.000`. Acceptance #15 moves PARTIAL → PASS for the rendering half;
  clicking Verify/Train is still untested.

**Not established**
- The two new UI cards have not been viewed or screenshotted, and have no automated UI test.
- Nothing here measures ranking benefit on live nodes: the LCB change is a guard, and the replay
  corpora contain no episode where it changes a decision.
- Iran vantage, throughput, sing-box engines and non-Windows targets remain as before.
