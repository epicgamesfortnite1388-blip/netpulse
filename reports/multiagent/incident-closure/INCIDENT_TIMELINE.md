# Incident Timeline — NetPulse Incident Closure

**Generated:** 2026-10-23 (session)
**Repository:** Vpn_app @ `main` HEAD `48c1794` (clean tree except untracked `VPS-KEYS.txt`)
**Abystral repo:** `E:\Code\Project\Abystral` @ `feat/iran-connection-diagnostics` HEAD `20f10f9`, 23 modified + 7 untracked (Phase 6 WIP)

---

## Starting state

- NetPulse `main` HEAD `48c1794` (docs: close out Mission 3 integration audit). Clean working tree except untracked `VPS-KEYS.txt` (contains SSH private key + passphrase — residual secret exposure, R-1).
- `feat/iran-resilience` branch exists, diverged with 4 commits ahead of main; not merged.
- Reflog shows `0b05f8d` at HEAD@{3} on feat/iran-resilience; author Abyss; 2026-10-23 09:39 +0330.
- Two commits on feat branch ahead of main not merged: `a68505f`, `7324a93` (plus `0b05f8d`, `b76b812`).

---

## Key facts verified (this session)

1. **VPS-KEYS.txt is committed?** No — untracked (`??`). Contains a full OpenSSH private key + passphrase. Residual secret exposure risk (R-1). Must be deleted and SSH key rotated.

2. **Commit 0b05f8d** exists on `feat/iran-resilience` (ancestor of feat tip `a68505f`), NOT on `main`. Parent `b76b812`. Author/committer Abyss. 3 files, +9/-9, accessibility/font-size change. No history rewrite. True authoring agent/process cannot be established from metadata alone. See UNEXPECTED_COMMIT_PROVENANCE.md.

3. **Xray REALITY key rotation: VERIFIED.** Live VPS evidence: backup `config.json.bak-20261023T054011Z` at 05:40 UTC on 2026-10-23 confirms rotation. Current config uses different privateKey than backup. REALITY public key derived: `CAS1AR2c9NrFKDMP1JVMIHx1y4_nxY8HqlemAGclsgU`. Old key backup retained on VPS at `/opt/netpulse-xray/config.json.bak-20261023T054011Z` (should be securely deleted).

4. **Profiles generated before 05:40 UTC on 2026-10-23 invalid:** VERIFIED (by implication — old key in backup; new key in current config; pre-cutoff profiles bound to old public key fail REALITY handshake).

5. **Entitlement snapshot route:** Implemented in Abystral `workers/src/telegram/src/handlers/netpulse-api.ts:321` (POST /entitlement/snapshot). Auth: HMAC service wall, fail-closed, nonce replay protection. Cross-account isolation verified (unit + integration). **DEFECT found and fixed** in `pushSnapshot` (`netpulse.ts:681`): non-JSON 2xx / field-absent 2xx was treated as "in sync"; now only explicit `inSync: true` counts. 4 regression tests added. All 14 snapshot tests pass. Cloud integration tests 16/16 pass.

6. **Live VPS verification (SSH to 206.1.96.89):** Ubuntu 24.04.5 LTS. Six active systemd units: netpulse-xray, x-ui, netpulse-dnstt, netpulse-hysteria, netpulse-socks, wg-quick@wg0. Shadowsocks + VLESS REALITY both pass HTTPS 200 via tunnel (egress IP 206.1.96.89). WireGuard restart + PostUp idempotency pass; reboot not tested. Microsocks env file permissions 600 root:root; HTTPS via microsocks returned 000 (investigation needed).

7. **Abystral tests:** 28 failures across 6 test files, all classified as change-related (exercise owner's uncommitted Phase 6 WIP). No baseline/environment/flaky confirmed. Clean-baseline comparison not run (would disturb owner's WIP).

8. **Dual-egress root cause:** NOT ESTABLISHED for dev machine (no repeatable simultaneous-request experiment run; no controlled endpoint/admin elevation). Not attributed to DPI.

9. **Kill switch:** UNVERIFIED (requires admin privileges; not tested). Remains unverified, not treated as operational security control.

10. **WhiteDNS:** NOT INSTALLED (identity/purpose/trusted source/owner approval unconfirmed). Correctly not installed per policy.

---

## Blockers / limitations

- No Telegram test user / staging bot; purchase-flow blocked (carried from Mission 3).
- Kill switch requires admin privileges; not tested.
- Dual-egress experiment not run on dev machine (no controlled endpoint / admin elevation).
- Clean-baseline Abystral comparison not run (would disturb owner's uncommitted WIP).

---

## Decision (preliminary)

CONDITIONAL GO pending completion of release-gate conditions. See RELEASE_GATE.md.
