# NetPulse Roadmap Decisions — November 2026

## P-01: Hosted-tunnel replacement after VPS loss

**Decision:** **Free-source-only path** (option 2). The project will treat the 34,150 free-source configs (9 sources, all read-only, no host dependency) as the primary tunnel path. Aether is the serverless fallback. This eliminates host operational cost and removes the single point of failure represented by the retired VPS. The paid-host path is deferred until a later phase when infrastructure funding is available.

**Rationale:** The VPS at 206.1.96.89 was retired on 2026-11-02. Both built-in config feeds (Epodonios/v2ray-configs, ebrasha/free-v2ray-public-list) are marked `retired: true`. Replacing with a paid host would incur ongoing cost and reintroduce the host-dependency that the roadmap is designed to eliminate. The free-source path is already quantified (34,150 configs, 0 failures from 9 enabled sources) and does not require a persistent server.

**Commitments:**
- Keep `scripts/free-config-probe.ts` as the canonical source-probing tool
- Document per-source config counts in the inventory (already done: mheidari98 14,920 · barry-far 8,699 · mahdibland 4,579 · ALIILAPRO 4,058 · MhdiTaheri 1,115 · peasoft 417 · ts-sf 200 · 0xRadikal 100 · ermaozi 62)
- Aether remains the serverless fallback when free-source connect rates are insufficient
- WhiteDNS zone delegation is withdrawn (see D-01); no host = no zone

**Evidence cited:** `reports/accounting/VPS_LOSS_ACCOUNTING_2026-11-02.md`; `reports/accounting/FREE_CONFIG_INVENTORY_2026-11-02.md`; `scripts/free-config-probe.ts`; `apps/api/src/services/missionControl.ts` (host row `unavailable`); headline numbers: 9 enabled, 34,150 total, 0 failures

---

## D-01: WhiteDNS — withdraw the zone delegation

**Decision:** **Withdraw the delegation** (option 1). The WhiteDNS zone `gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org` was delegated from the retired VPS host `206.1.96.89`. The zone is stale — no nameserver serves it, and keeping it listed creates a false promise. The zone reference is removed from the codebase and UI. Any documentation referencing the zone is updated.

**Rationale:** The zone delegation has no operational nameserver. The Soar panel (v0.6.0) shows no active serving. Since P-01 chooses the free-source-only path (no host), there is no infrastructure to host the zone. Keeping a dead zone reference violates the roadmap's honesty principle (Iran-ready: 0/5 satisfied; "do not fabricate passes").

**Commitments:**
- Remove the WhiteDNS zone reference from all code, docs, and UI
- Update `whitedns-design.md` to reflect withdrawn status
- Remove any DNS delegation config that points to the retired VPS IP
- The `missionControl.ts` host row `unavailable` remains as the authoritative status

**Evidence cited:** `reports/accounting/VPS_LOSS_ACCOUNTING_2026-11-02.md` (WhiteDNS Soar panel v0.6.0, zone `gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org`); `docs/research/dpi/whitedns-design.md`; Mission Control host row `unavailable`; Iran-ready definition (5 requirements, 0 satisfied — fabricating a zone would violate requirement 5)

---

## Summary

| Decision | Chosen Option | Status | Blocks |
|---|---|---|---|
| P-01: Host replacement vs free-source path | **Free-source-only** (option 2) | **RESOLVED** | W3 (provisioning decision) fully unblocked |
| D-01: WhiteDNS withdraw or fund | **Withdraw** (option 1) | **RESOLVED** | W4 (DNS workstream) fully unblocked |

**Phase 1** is now unblocked. The roadmap can proceed from the verified Phase 0 level (Aether channel PASS, free-config measurement DONE, no server needed) into workstream execution.

| Workstream | Status | Notes |
|---|---|---|
| W1: Aether connect / exit-IP proof | **PASS (lab, 2026-11-03)** — install + relay + differing exit IP measured | v2.4.0 installed via `installAether()` (SHA256 verified); SOCKS5 relay true; exit `104.28.197.9` vs baseline `83.229.87.141`; non-Iranian network, both DE — see `reports/accounting/AETHER_TUNNEL_PROOF_2026-11-03.md` |
| W2: Free config connect rates | **MEASURED (2026-11-03)** — 16/270 reachable (5.9%), concentrated in three feeds | Inventory 34,150 / 9/9 sources / 0 failures. Per-source yield: barry-far 23.3%, MhdiTaheri 13.3%, 0xRadikal 10.0%, ALIILAPRO 3.3%, ermaozi 3.3%, four feeds 0%. A 60-config three-feed run gave 1.7% (same per-feed rates). xray 26.10.31. Survival over a 25-minute gap: 6/7 endpoints held (85.7%); the single death was the slowest round-1 survivor. See `reports/accounting/FREE_CONFIG_CONNECT_RATES_2026-11-03.md` and `FREE_CONFIG_SURVIVAL_2026-11-03.md` |
| W3: Provisioning decision | **UNBLOCKED** — P-01 resolved (free-source-only) | Can now proceed to config sampling and tunnel measurement |
| W4: DNS workstream | **UNBLOCKED** — D-01 resolved (WhiteDNS withdrawn) | WhiteDNS zone removed; no host = no DNS delegation needed |
| W5: Iranian vantage acquisition | **BLOCKED** — no Iranian vantage available on this machine | Requires external research/orchestration; overarching distance-to-goal |
| W6: Censorship-resistance claim | **BLOCKED** — 0/5 Iran-ready requirements satisfied | Roadmap exists to close this distance; W5 is a prerequisite |
| W7: Performance baselines | **PENDING** — after W5/W6 unblock | Will need repeatable measure paths |
| W8: Security review & do-not-do | **READY** — documented; negative controls executed 4/4 PASS (2026-11-03) | do-not-do list merged; includes: no curl probes (debug proxy), no fabricate, no Iran claim without vantage. Controls cover blocked peer, occupied port, corrupt identity, post-failure egress; expired-profile control has no mechanism to exercise |
| W9: Mission Overdrive dashboard | **DONE** (2026-11-03) | Rationale: the evidence lived in JSON artifacts the UI could not show, so a reader had to trust prose. The dashboard parses those artifacts (`GET /api/v1/mission/overdrive`), classifies each row, and degrades to `unavailable` with a reason instead of showing zero. It parses the research registry and ROADMAP requirements rather than copying them, so a doc edit changes the page. Decided against: any control button — the page stays read-only; and any hand-maintained status table — parsing the authoritative file is the only version that cannot drift |

---

**Phase 0** is complete at the verification level. **Phase 1** has W1 done at the lab level (Aether installs, relays, and egresses from a different AS — 2026-11-03), leaving W2/F-05 (free-config tunnel measurement) as the most immediate actionable workstream, and W5 (Iranian vantage) as the gate on every Phase 2 claim. The Iran-ready definition (5 requirements, 0 satisfied) remains the distance-to-goal that the roadmap exists to close.

