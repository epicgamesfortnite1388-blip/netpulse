## NetPulse Anti-DPI Roadmap — November 2026

### W0: Project Overview & Traceability Matrix
- **Status:** COMPLETE
- Maps every task to its source document (bibliography S01–S35, threat model, mechanisms, techniques, protocol comparison, DNS analysis, ECH analysis, WhiteDNS design, methodology, security review, live Soar result)
- Do-not-do list merged from all sources plus post-VPS additions

### W1: Aether Engine — serverless tunnel (connect / exit-IP proof)
- **Status:** PASS (lab) — binary installed, tunnel relayed, exit IP differs from baseline. Evidence: `reports/accounting/AETHER_TUNNEL_PROOF_2026-11-03.md`
- Install via the app's own pipeline: v2.4.0, SHA256 sidecar verified, `-v` self-check `2.4.0`, 6.5 s, → `aether/aether.exe`
- Tunnel: `--masque --noize gfw --startup-secs 90 --validate-secs 30` on `127.0.0.1:1819`; QUIC h3, `connect-ip status: 200`, data-plane validated
- Proof: `socks5RelayCheck` true; `fetchExitIpThroughSocks` → `104.28.197.9` (AS13335 Cloudflare, DE) vs baseline `83.229.87.141` (AS204548 Kamatera, DE); 5/5 probes stable, 265–283 ms
- Negative results worth keeping: default `firewall` noize timed out at 30 s; `--h2 --fragment --scan balanced` found no gateway in 3×120 s; forced h2 peer returned `connect-ip status: 400`
- **Scope limit:** non-Iranian lab network, same country (DE) as baseline — proves different AS/path, not a country change, and nothing about Iranian ISPs
- Tooling note: `curl` on this machine is a debug build hardwired to a dead `127.0.0.1:10809` proxy; all probes used Node `fetch`
- **Known limitation (measured 2026-11-03):** Aether's SOCKS5 refuses hostname-form CONNECT (ATYP 0x03), so names are resolved by the **local resolver, outside the tunnel** — payload is tunnelled, names are not. Stage data: `reports/accounting/TUNNEL_STAGES_2026-11-03.md`

### W2: Free‑source Config Inventory & Connect Rates
- **Status:** COMPLETE (inventory) · snapshot measured (connect rate) — 34,150 parseable configs from 9 enabled sources, 0 failures; 1/60 sampled configs dialable on 2026-11-03
- Measured via `scripts/free-config-probe.ts` (--out, --only, --timeout, --max-bytes; skips disabled sources) for inventory and `scripts/free-config-connect.ts` (`npm run probe:connect`) for connect rates
- Per-source breakdown:
  - mheidari98: 14,920 parsed · barry-far: 8,699 · mahdibland: 4,579 · ALIILAPRO: 4,058 · MhdiTaheri: 1,115 · peasoft: 417 · ts-sf: 200 · 0xRadikal: 100 · ermaozi: 62
- Parse rates: barry-far 99.2%, 0xRadikal 100.0%, mahdibland 98.7%, MhdiTaheri 57.7%, peasoft 86.3%, ermaozi 96.4%, ts-sf 99.5%, ALIILAPRO 98.9%
- **F-05:** Inventory done (34,150 total, 9/9 sources, 0 failures). Connect rate measured 2026-11-03 across all nine sources: **16/270 reachable (5.9%)**, and yield is source-concentrated — barry-far 23.3%, MhdiTaheri 13.3%, 0xRadikal 10.0%, ALIILAPRO 3.3%, ermaozi 3.3%, mahdibland / mheidari98 / peasoft / ts-sf 0%. A narrower 60-config run over three feeds gave 1.7%; the gap is source mix, not timing (both runs agree per feed where they overlap). Evidence: `reports/accounting/FREE_CONFIG_CONNECT_RATES_2026-11-03.md`. Survival measured over a 25-minute gap: **6/7 endpoints survived (85.7%)**, the one death being the slowest round-1 survivor (`FREE_CONFIG_SURVIVAL_2026-11-03.md`). Still open: one-hour survival, full-inventory census.

### W3: Provisioning Decision (P-01)
- **Status:** RESOLVED — Free-source-only path (option 2). No paid host; VPS retired 2026-11-02. Decision recorded in `DECISIONS_2026-11-02.md`.
- Blocks: none (decision finalized)

### W4: DNS Workstream (D-01)
- **Status:** RESOLVED — WhiteDNS zone withdrawn (option 1). Zone `gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org` delegated from retired VPS; no nameserver serves it. Reference removed from codebase and UI. Decision recorded in `DECISIONS_2026-11-02.md`.
- Blocks: none (decision finalized)

### W5: Iranian Vantage Acquisition
- **Status:** BLOCKED — no Iranian vantage available on this machine
- Five "Iran-ready" requirements (0/5 satisfied): (1) voluntary Iranian vantage with timestamp/ASN/ISP/consent, (2) ≥20 repeat results per path, (3) real client + independent egress observation, (4) negative controls + fallback path, (5) documented failure taxonomy (not just success rate)
- **Blocks:** W6 (censorship-resistance claim); overarching distance-to-goal

### W6: Censorship‑Resistance Claim
- **Status:** BLOCKED — 0/5 Iran-ready requirements satisfied
- Roadmap exists to close this distance; W5 is a prerequisite

### W7: Performance Baselines
- **Status:** PARTIAL — lab baselines now exist for the two paths that can be dialled without a vantage; Iranian baselines stay blocked on W5
- Aether (SOCKS5, 5 probes, `api.ipify.org`): 265–283 ms, exit stable
- Free-config sample (n=270, 12 s budget): handshake+request latency min 350 ms / median 1,179 ms / max 10,579 ms; 5.9% reachable
- Repeatable paths: `npm run controls:aether`, `npm run probe:connect`, `npm run probe:survival`, `npm run measure:stages`, plus the existing `proof:vpn` / `bench:bulk-probe` scripts. No throughput (bandwidth) baseline yet — all figures are latency to a single small response
- Staged baseline (Aether, 20 rounds, medians): local DNS 1 ms · SOCKS CONNECT 80 ms · TLS 92 ms · HTTP TTFB 197 ms · end-to-end 372 ms

### W9: Mission Overdrive — evidence ledger & dashboard
- **Status:** DONE (2026-11-03) — `GET /api/v1/mission/overdrive` + `/overdrive` page; every figure parsed from the artifact that recorded it, unreadable artifacts render as `unavailable` with the reason (7 regression tests)
- Rows: catalog census, connect rate, survival, stage timings, negative controls — each with metrics, caveats and artifact path
- Also renders the research registry (37 entries, live parse of `bibliography.md`) and the Iran-ready ledger (parsed from this file, not copied)
- Added and verified 2026-11-03: S36 Psiphon Tunnel Core (GitHub API: pushed 2026-11-02, GPL-3.0), S37 Tor anti-censorship / bridgestatus (GitLab API: 24 projects, active 2026-10-16)
- No mutation surface: the page re-reads and nothing else

### W8: Security Review & do-not-do List
- **Status:** READY — documented from all sources
- do-not-do list merged: no curl probes (debug proxy), no fabricate, no Iran claim without vantage
- **Negative controls (requirement 4) — executed 2026-11-03: 4/4 PASS.** `scripts/negative-controls.ts` proves the relay/exit-IP proof refuses to certify a blocked peer, an occupied port, and a corrupt identity, and that egress is unchanged afterwards. Evidence: `reports/accounting/NEGATIVE_CONTROLS_2026-11-03.md`. Remaining gap: an "expired profile" control has no expiry mechanism to exercise.

---

## Iran‑Ready Definition (5 requirements, currently 0/5 satisfied)

1. **Voluntary Iranian vantage** with timestamp, ASN/ISP, access type, and consent — **NOT AVAILABLE**
2. **Separate DNS, TCP, TLS, HTTP stage results**, ≥20 repeats per path where safe — **PARTIAL (lab)** — 20/20 rounds on the Aether path: DNS 1 ms (local resolver), SOCKS CONNECT 80 ms, TLS 92 ms, HTTP TTFB 197 ms, end-to-end 372 ms median (`TUNNEL_STAGES_2026-11-03.md`). Iranian stages and per-path repeats still **NOT MEASURED**
3. **A real client and a server‑side or independent egress observation** — **NOT AVAILABLE**
4. **Negative controls (wrong key, expired profile, blocked port) AND a fallback path** — **PARTIAL** — wrong key, blocked port (unreachable peer + occupied port) and post-failure egress all verified 4/4 (`NEGATIVE_CONTROLS_2026-11-03.md`); expired-profile control **NOT COVERED** (no expiry mechanism exists)
5. **A documented failure taxonomy — not a single success rate** — **DOCUMENTED** (roadmap exists to close this distance)

> *Today the project satisfies none of the five for any transport. That is the honest distance between the current build and a censorship-resistance claim, and it is the number this roadmap exists to close.*

---

## Open Questions (from ROADMAP.md §8)

| # | Question | Blocks | Owner |
|---|---|---|---|
| 1 | Does Aether actually carry traffic from this network? | **ANSWERED 2026-11-03 (lab, non-Iranian): yes** — relayed, exit IP differs (`AETHER_TUNNEL_PROOF_2026-11-03.md`). Still open for an Iranian network. | engineering |
| 2 | Is there a replacement host, or does the paid tier go away? | `W3`, `W4`, plan copy | owner |
| 3 | Is WhiteDNS worth resurrecting with per-user zones? | `W4` | owner |
| 4 | Can any Iranian vantage be obtained (with consent)? | every Phase 2 claim | owner / research |
| 5 | Which free-source configs survive more than an hour? | `F-05` | engineering — snapshot done (5.9%, n=270); **25-minute survival 6/7 (85.7%)**; one-hour survival still **NOT TESTED** (`FREE_CONFIG_SURVIVAL_2026-11-03.md`) |

---

## Phase Status

| Phase | Status | Key Unblockers |
|---|---|---|
| **Phase 0** | ✅ VERIFIED | Aether channel PASS; free-config measurement DONE; no server needed |
| **Phase 1** | 🟡 IN PROGRESS | W1 **done at lab level**; W2/F-05 **measured** (5.9%, n=270, per-source yield); W9 evidence dashboard **done**; requirement 2 **measured at lab level** (and the DNS leak it exposed is open); requirement 4 **partial** (negative controls 4/4); remainder: W5 (Iranian vantage), 1-hour survival, **DNS-inside-tunnel fix**, IPv6/reconnection tests |
| **Phase 2** | ⚪ PENDING | Iran-ready: all 5 requirements satisfied (distance-to-goal) |
| **Phase 3** | ⚪ PENDING | Production deployment with censorship-resistance guarantees |

**P-01 and D-01 are RESOLVED** (free-source-only path, WhiteDNS withdrawn). W3 and W4 are unblocked. The roadmap can proceed from the verified Phase 0 level into workstream execution.