# Remaining Risks — NetPulse Incident Closure

**Generated:** 2026-10-23 (session)

| ID | Severity | Risk | Status | Evidence |
|---|---|---|---|---|
| R-1 | HIGH | `VPS-KEYS.txt` untracked in working tree contains a full SSH private key + passphrase. Must be deleted; key rotated. | OPEN | File confirmed present (672 bytes, written 2026-10-23 00:26:47). Contents not read. |
| R-2 | HIGH | Old Xray REALITY key backup retained on VPS at `/opt/netpulse-xray/config.json.bak-20261023T054011Z` — contains compromised key material. | OPEN | Live VPS evidence: backup file exists at 05:40 UTC timestamp; current config uses different key. |
| R-3 | HIGH | Dual-egress root cause not established (Xray children vs Node/curl on dev machine). Cannot claim DPI or fix. | OPEN | Code inspection only; no repeatable experiment run (no controlled endpoint/admin elevation). |
| R-4 | HIGH | Entitlement drift repair not demonstrated end-to-end (live staging). | OPEN | Code present + unit-tested (14/14 including 4 new regression tests); pushSnapshot defect fixed; live e2e not run (no test user/staging bot). |
| R-5 | MEDIUM | Unexpected commit `0b05f8d` authorship unverified. | OPEN | Metadata/diff/branch known; true authoring agent/process cannot be established from Git metadata alone. |
| R-6 | MEDIUM | 28 Abystral test failures not fixed (all classified change-related, in owner's uncommitted Phase 6 WIP). | OPEN | 28 failures across 6 files captured and classified; clean-baseline comparison not run (would disturb owner's WIP). |
| R-7 | MEDIUM | WireGuard reboot persistence not tested (no reboot performed per policy). Microsocks HTTPS returned 000 (investigation needed). | PARTIAL | Restart + PostUp idempotency verified live; reboot and microsocks HTTPS not verified. |
| R-8 | LOW | Kill switch unverified (requires admin privileges). | OPEN | Not tested; described as unverified, not treated as operational security control. |
| R-9 | LOW | WhiteDNS uninstalled/unidentified — do not install until identity/purpose/trusted source/owner approval established. | OPEN | Not installed; compliant with policy. |
| R-10 | LOW | Purchase-flow blocked (no test user / staging bot). | OPEN | Carried from Mission 3. |

## Risks retired this session

- **Key rotation confirmed** (was HIGH residual): Live VPS evidence confirms REALITY key rotated at 05:40 UTC 2026-10-23; new key verified via live VLESS REALITY handshake. Downgraded from "unverified" to verified; remaining work is deletion of old backup + client reissuance enumeration.
- **pushSnapshot drift-detection defect fixed** (was a gap): `data?.inSync !== false` → `data?.inSync === true`; 4 regression tests added; 14/14 pass.
- **Cloud entitlement integration verified**: 16/16 netpulse-integration tests pass; cross-account isolation confirmed.
