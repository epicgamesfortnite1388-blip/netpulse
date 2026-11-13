# NetPulse New Acceptance Matrix

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Status vocabulary:** `PASS` · `PARTIAL` · `BLOCKED` · `NOT TESTED`
A criterion is `PASS` only when an artifact, test, or measured run is named for it. "The code exists" is `PARTIAL`.

---

## 1. Matrix

| # | Acceptance criterion | Status | Evidence | What is still missing |
| ---: | --- | --- | --- | --- |
| 1 | The actual Aether implementation has been inspected | **PASS** | `AETHER_ARCHITECTURE.md`; PattNG `my-releases/.gitmodules`; submodule commit `d58f9d5…`; `Cargo.toml` (AGPL-3.0-only, quiche/smoltcp/boringtun); `aether --version` → 2.4.0 | Android binding mechanism inside PattNG not inspected |
| 2 | Aether is integrated into the real target client where technically supported | **PASS** (Windows) / **NOT TESTED** (Android, macOS, Linux) | `aetherProvider.ts` 976 lines; relay + exit-IP verification; `AETHER_INTEGRATION_REPORT.md`; negative controls 4/4 | No non-Windows build was run |
| 3 | The application can import and manage supported configurations | **PASS** | `/api/v1/vpn/profiles`, `/api/v1/nodes/import`, `/api/v1/sources`; `app.test.ts` + node tests in the 1,198-test suite | — |
| 4 | Public configuration discovery works | **PASS** | 9/9 feeds, **34,150** parseable configs, 0 network failures (`free-config-probe-2026-11-02.json`) | — |
| 5 | Multiple legitimate public sources are registered | **PASS** | 11 registered, 9 enabled (`getKnownSources()`); registry table in `FREE_CONFIG_SOURCE_REGISTRY.md` | Telegram and website feeds deliberately excluded |
| 6 | Duplicate and malformed configurations are handled | **PASS** | `canonical_fingerprint` UNIQUE; 34,150 links collapse to distinct endpoints; duplicate feed rejected by identical sha256; parse rates 99.5% / 98.9% / 86.3% | — |
| 7 | Engine compatibility is checked | **PASS** | `engineSupports`/`engineSupportsConfig`; SmartConnect excludes with `no-engine-installed` vs `unsupported-protocol`; tests assert both | sing-box unavailable → Hysteria2/TUIC structurally unsupported |
| 8 | Configurations are tested using bounded methods | **PASS** | 270 samples, 12 s budget, concurrency 6, per-source rate limits, 30/source | Bounded on one vantage only |
| 9 | Actual traffic verification is implemented | **PASS** | `proxyProbeWithEngine` reaches `done` only when a request traversed the core; exit-IP proof; negative controls 4/4 | UDP/QUIC path unverified |
| 10 | Smart Connect chooses a validated candidate | **PASS** | `smartConnect.ts` + routes; **40/40 tests** (incl. a bounded-concurrency pool: ≤ 3 lanes, refills only while unverified, rank order beats finish order; a training batch that probes failures too and stamps each observation with the model's probability; and prescreens for the two configs xray refuses); **live**: 10 training batches, 56 dials, 4 verified, **157 of 300** ranked rows excluded as `engine-rejects-config`; **live run**: 699 nodes imported from one feed, plan 300 candidates in 43 ms, `POST` verified Shadowsocks/xray at 580 ms HTTP 200 in 931 ms across 2 probes; `node_tests` + adaptive state written (`reports/accounting/SMART_CONNECT_LIVE_2026-11-04.md`) | Only one live run, on one vantage |
| 11 | The local adaptive AI changes actual connection decisions | **PASS** | `AdaptiveEngine` reorders cores in `quickConnectCore`; replay: censored corpus 0/15 → 5/15, 1 win / 0 losses on ISP path; ±8 nudge + observation per attempt in SmartConnect, now actually reaching an engine (strategy ids are `xray+doh`, which the old `:` split never matched); `POST /v1/vpn/smart-connect/train` trains on whole batches | Calibration **measured live**: 12 scored samples, Brier 0.146 vs 0.25 baseline, skill **+0.104** (one vantage, small sample — direction only); effect size of the node-level nudge **NOT TESTED** |
| 12 | User privacy and configuration secrets are protected | **PARTIAL** | AES-256-GCM vault, master key in Windows Credential Manager (DPAPI); node DTOs omit addresses; SSRF-hazard duplicate module **removed** | `aether/aether-masque.toml` holds a private key + token in plaintext (git-ignored); UDP leak matrix open |
| 13 | Untrusted configurations are clearly labeled | **PASS** | 8-value trust ladder in `smartConnect.ts`; warnings in every plan `limits`; security review | UI rendering of every category not screenshot-verified |
| 14 | The application works without the former VPS | **PASS** | No VPS host is configured or required; discovery, storage, selection, engines are all local; tests boot the API against temp data dirs (`netpulse-*` boot logs) | Former provisioning modules still exist but are inert |
| 15 | The interface displays real metrics | **PASS** | `/api/v1/mission/overdrive` + mission pages read measured artifacts; Aether surfaces show live tunnel state; **`SmartConnectCard`** renders the real plan, exclusion counts (incl. `refused by the installed core: 178`), per-candidate components and verification result; **`AgentAutonomyCard`** shows live budgets, capability tiers, permanently-denied list, recent refusals, each enforcement point, the model's Brier skill and a Train action. Both **rendered in the running app** against the trained database (`GET /vpn/smart-connect?limit=300` and `GET /agent/permissions` → 200; console showed only the designed 401→session re-issue): `reports/screenshots/vpn-smart-connect.png`, `reports/screenshots/vpn-agent-autonomy.png`. **Automated render test:** `apps/web/test/vpnDecisionCards.test.tsx`, 11 tests on the extracted bodies | No interaction test for the Verify/Train buttons (their POST paths are covered in the API suite); no keyboard or a11y audit |
| 16 | Tests pass | **PASS** | `npx vitest run` → **107 files / 1,198 tests**, exit 0 (228.3 s); `apps/web` 52 files / **472**, `packages/shared` 10 files / **136** — 1,806 total; `tsc --noEmit` exit 0 in api, shared and web; `eslint packages/shared/src apps/api/src apps/web/src` exit 0; `vite build` exit 0 (9.3 s) | Two failures from this session's changes were caught and fixed before this result: a meta-test found the autonomy card fetching `/api/v1/api/v1/...` (double prefix), and a scanner test asserted on a 5 s wall-clock window that full-suite load exceeded |
| 17 | The final report and grade are generated | **PASS** | `NETPULSE_FINAL_GRADE.md` + the ten required reports | — |

**Tally:** 13 PASS · 3 PARTIAL · 0 BLOCKED · 1 NOT TESTED (non-Windows targets).

---

## 2. Criterion-by-criterion notes where honesty matters most

### #2 — "where technically supported"

Windows is genuinely supported: upstream ships `aether-windows-x86_64.zip`, and the integration runs a real process with verified data-plane behaviour. Android is **not** claimed: PattNG embeds the core, but NetPulse has not inspected how, and has no Android target. Emulator or shim claims are not made.

### #10 — what the live run changed

The first pass through this criterion was PARTIAL: the logic was tested with injected probes but the route had never been exercised. The live run closed it and found three defects that unit tests had not:

1. with no core discoverable, the empty-list message blamed the configurations instead of the missing engine;
2. newly imported rows (`freshness: 'stale'` by construction) would have been filtered out wholesale;
3. a TCP-only success scored 93 and displaced a node that had actually carried HTTP traffic at 580 ms — port-only evidence is now capped at 70.

All three are fixed and covered by tests. The evidence is `reports/accounting/SMART_CONNECT_LIVE_2026-11-04.md`.

### #12 — why PARTIAL

The credential story is stronger than most consumer VPN clients (no plaintext key file beside the ciphertext; addresses withheld from responses; a real SSRF hole was found and closed). It is still PARTIAL because the Aether identity file is a plaintext credential on disk and because the leak matrix has an unmeasured UDP branch.

### #15 — why PARTIAL

The mission pages do read real measured artifacts, and the Aether surfaces show live state. But the new Smart Connect decision surface exists only as an API. Shipping an API with no visible control means the user cannot use the feature from the app, and that is a real gap rather than a documentation issue.

---

## 3. What would move each PARTIAL to PASS

| Criterion | Smallest honest step |
| ---: | --- |
| #10 | **Done** — live call verified a node and wrote the test row; a second run re-verified in one probe |
| #12 | Encrypt the Aether identity through `FileSecretVault`; extend the leak harness to UDP/QUIC |
| #15 | **Done** — `SmartConnectCard` renders decision, exclusion counts, top 3 candidates with components and the verification result; remaining gap is visual verification only |
| #2 (non-Windows) | Build/run the Linux or Android target; until then it stays NOT TESTED, not "supported" |

---

## 4. Claims this project does **not** make

- That free public configurations are safe, private, fast, or durable.
- That any Iranian ISP can reach these endpoints.
- That the client guarantees anonymity. Aether's operator is Cloudflare; a free node's operator is unknown.
- That discovery equals connectivity. **34,150 discovered, 16 verified carrying traffic in a 270 sample.**
- That the adaptive AI is the reason connections succeed. Most of the gain is evidence-based ranking and correct engine routing.
