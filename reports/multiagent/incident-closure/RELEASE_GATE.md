# Release Gate — NetPulse Incident Closure

**Generated:** 2026-10-23 (session)

## Decision: CONDITIONAL GO (controlled alpha, restricted scope)

Not a full GO: several exit criteria remain unverified. Not a NO-GO: the core security and integrity paths (key rotation, entitlement auth/isolation, live HTTPS through tunnels) are verified.

---

## Exit-criterion answers (required by mission)

| # | Exit criterion | Answer | Evidence |
|---|---|---|---|
| 1 | Profile reissuance working / user notice accurate | **PARTIAL** | Key rotation VERIFIED (VPS backup 05:40 UTC 2026-10-23; current config uses different key; live VLESS REALITY handshake PASS). Statement "profiles before 05:40 UTC invalid" accurate per backup timestamp. Exact client reissuance list not yet enumerated from VPS profile store. User notice can be published only after profile-store enumeration confirms which clients hold pre-cutoff profiles. |
| 2 | Residual secret exposure remains | **YES (two vectors)** | (a) `VPS-KEYS.txt` untracked in working tree — full SSH private key + passphrase (672 bytes). Must be deleted; SSH key rotated. (b) VPS retains old REALITY key backup at `/opt/netpulse-xray/config.json.bak-20261023T054011Z` — compromised key material; securely delete after confirming new key works. No committed Xray REALITY key found in Vpn_app source. |
| 3 | Dual-egress root cause established | **NO** | Not established for dev machine. No repeatable simultaneous-request experiment run (no controlled endpoint / admin elevation). Not attributed to DPI. Code inspection only. |
| 4 | Entitlement drift detection/correction proven e2e | **PARTIAL** | Code present and unit-tested (14/14 snapshot tests incl. 4 new regression tests for pushSnapshot defect). Cloud integration 16/16 pass; cross-account isolation verified. Live drift-repair e2e NOT demonstrated (no staging bot/test user). pushSnapshot DEFECT fixed (`data?.inSync === true`). |
| 5 | Unexpected commit `0b05f8d` — known vs uncertain | **KNOWN: SHA, metadata, diff, parent chain, branch membership (feat/iran-resilience only, not main), reflog, ancestry vs main, content (no secrets). UNCERTAIN: true authoring agent/process; whether intentional; exact tooling.** | `0b05f8d` IS ancestor of feat tip `a68505f`, NOT ancestor of main `48c1794`. No rewrite/amend. Attribution ≠ authorship. Preserved (no history rewrite). |
| 6 | 28 Abystral test failures — fixed / baseline / environmental / unresolved | **28 change-related (classified), 0 fixed, 0 baseline confirmed, 0 flaky confirmed** | All 28 captured individually across 6 test files; all exercise owner's uncommitted Phase 6 WIP. Clean-baseline comparison NOT run (would disturb owner's WIP — prohibited). Fixes not applied (owner's files). |
| 7 | WireGuard persistence and service recovery verified | **PARTIAL** | Live VPS: `wg-quick@wg0` active; restart verified (2x); PostUp idempotency verified (MASQUERADE not duplicated). Reboot NOT tested (no reboot per policy). WireGuard peer client not tested (no peer available). |
| 8 | Kill switch verified | **NO — remains unverified** | Requires admin privileges in controlled environment. Not tested. Described as unverified, not treated as operational security control. |
| 9 | Production / live integration paths not tested | Purchase-to-entitlement (blocked — no test user/staging bot); live VPN/TUN from dev machine; dual-egress experiment; entitlement drift repair e2e; WireGuard reboot; kill switch; microsocks HTTPS e2e (returned 000); profile reissuance live e2e. | Listed above. |

---

## Conditions to move to GO

1. **Delete `VPS-KEYS.txt`** from the working tree; rotate the compromised SSH key. Treat passphrase as compromised.
2. **Securely delete `/opt/netpulse-xray/config.json.bak-20261023T054011Z`** on the VPS after confirming the new REALITY key works with live clients.
3. **Enumerate VPS profile store** to confirm which clients hold pre-05:40 UTC profiles; publish user notice only after confirmation.
4. **Run dual-egress experiment** (repeatable, simultaneous timestamped requests from Xray child vs Node/curl to controlled endpoint) and document mechanism or remaining uncertainty. Do not attribute to DPI.
5. **Demonstrate entitlement drift detection + repair e2e** on staging without cross-account exposure (intentional inconsistency → detection → repair).
6. **Verify WireGuard reboot persistence** and microsocks HTTPS (returned 000) with an authorized VPS session and recovery plan. Do not reboot/change firewall without authorized plan.
7. **Classify all 28 Abystral failures definitively** via clean-baseline comparison (`git stash` → rerun → `git stash pop`), then fix verified regressions in owner's WIP (coordinated).
8. **Verify kill switch** in privileged controlled environment; until then keep described as unverified.
9. **Complete purchase-flow** (staging bot or test user) — blocked since Mission 3.

---

## What was verified this session (basis for CONDITIONAL GO)

- Xray REALITY key rotation at 05:40 UTC 2026-10-23 (VPS backup timestamp + live handshake with new derived public key).
- `pushSnapshot` drift-detection defect fixed; 14/14 snapshot tests pass; cloud netpulse-integration 16/16 pass; cross-account isolation verified.
- egress proxy unit tests 22/22 pass.
- Live VPS: Shadowsocks + VLESS REALITY both pass HTTPS 200 via tunnel (egress IP 206.1.96.89); WireGuard restart + PostUp idempotency pass; microsocks env file permissions 600 root:root.
- 28 Abystral failures individually classified (all change-related, owner's WIP).
- Commit `0b05f8d` provenance documented (on feat branch only, not main; authorship uncertain).
- WhiteDNS correctly not installed (identity unconfirmed).
- No secrets printed in any report.
