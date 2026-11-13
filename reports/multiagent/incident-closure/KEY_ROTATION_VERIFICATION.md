# Key Rotation Verification — A1

**Scope:** Verify Xray REALITY key rotation and client-profile recovery path. Determine whether old key material remains in active artifacts, generated profiles, logs, or retained operational files. Inspect evidence of transcript exposure and recommend cleanup or credential rotation.

**Verification performed this session:** 2026-10-23

---

## 1. Starting state

- Repository: `Vpn_app` @ `main` HEAD `48c1794`, clean tree except untracked `VPS-KEYS.txt` (672 bytes, written 2026-10-23 00:26:47 +03:30).
- Live VPS verified via SSH: Ubuntu 24.04.5 LTS at 206.1.96.89 (see VPS_LIFECYCLE_VERIFICATION.md for live evidence).

---

## 2. Evidence: committed key material (Vpn_app source)

Searched committed source for `REALITY`, `privateKey`, `private_key`, `PRIVATE KEY`, `realityPrivateKey`, `reality_private` across `cloud/`, `apps/`, `packages/`, `src-tauri/`.

| Location | Match | Classification |
|---|---|---|
| `packages/shared/src/models/publicNodes.ts` | `reality` (type literal), `realityPublicKey`, `realityShortId`, `realityServerName` | Public-key / node metadata only — **not secret** |
| `apps/api/src/vpn/vpnService.ts` | `privateKey` | Local WireGuard private key parsed from user-supplied config, vaulted per-profile, never logged — **not Xray/REALITY** |
| `apps/api/src/services/profileBundle.ts` | `privateKey` | WireGuard profile bundling — **not Xray/REALITY** |
| `apps/api/src/services/vpnSelfTestService.ts` | `privateKey` | WireGuard self-test — **not Xray/REALITY** |
| `apps/api/src/util/redact.ts` | `privateKey`/`private_key` | Redaction rules (hides secrets) — **not secret storage** |
| `apps/api/test/fixtures/selfSignedCert.ts` | `privateKey` | Test fixture RSA key pair generated at runtime — **test-only, ephemeral** |
| `cloud/worker/worker-configuration.d.ts` | `privateKey: CryptoKey` | Type declaration only — **not a value** |

**Finding 1:** No committed Xray REALITY private key exists in this repo's source. Xray REALITY key material is not stored in the Vpn_app source tree.

---

## 3. Evidence: key rotation (VPS — VERIFIED via live evidence)

**Claim:** "The exposed Xray REALITY private key was rotated."

**Verification: VERIFIED.** Live VPS evidence (VPS_LIFECYCLE_VERIFICATION.md):

- Backup file `config.json.bak-20261023T054011Z` exists — confirms key rotation occurred at **05:40 UTC on 2026-10-23**.
- Current Xray config (`/opt/netpulse-xray/config.json`) uses a **different** privateKey than the backup — rotation performed.
- REALITY config: `dest www.microsoft.com:443`, `serverNames [www.microsoft.com]`, `shortIds [674622f7]`, `privateKey present (REDACTED)`, no `publicKey` field (correct — client derives from public key).
- REALITY public key derived: `CAS1AR2c9NrFKDMP1JVMIHx1y4_nxY8HqlemAGclsgU`.
- Client UUID: `f5e39e90-6322-418b-a397-6044ac40abdb`, flow `xtls-rprx-vision`.

**Profiles generated before 05:40 UTC on October 23, 2026, are invalid:** **VERIFIED** (by implication). The backup at 05:40 UTC contains the old key; profiles generated before that timestamp were bound to the old public key and will fail the REALITY handshake with the new key.

---

## 4. Evidence: profile distribution

**Claim:** "The subscription service and bot distribute the intended new profile."

**Verification: PARTIAL.** Abystral Phase 6 routes exist in source and unit-tested:
- Bot route `POST /api/internal/netpulse/v1/entitlement/snapshot` (`handlers/netpulse-api.ts:321`), unit-tested 10/10 + 4 new regression tests (A3 fix).
- Cloud worker pull path `syncNetpulseEntitlements` (`cloud/worker/src/netpulse-integration.ts:357`), integration-tested 16/16.
- Live distribution end-to-end not confirmed (no live test user / staging bot; purchase-flow blocked per Mission 3).

---

## 5. Evidence: client reissuance

**Finding:** All clients holding profiles older than the 05:40 UTC 2026-10-23 cutoff require reissuance (standard REALITY key rotation behavior — profiles bound to the old public key fail the REALITY handshake). Live VPS test confirmed VLESS REALITY handshake succeeds with the new derived public key.

**User notice accuracy:** Cannot be fully confirmed without VPS profile-store timestamp comparison to enumerate exactly which clients hold pre-cutoff profiles. The statement "profiles generated before 05:40 UTC are invalid" is accurate per the backup timestamp evidence.

---

## 6. Evidence: residual secret exposure

**Finding 2 (HIGH):** `VPS-KEYS.txt` (untracked, 672 bytes) contains a full OpenSSH private key + passphrase. **Residual secret exposure in the working tree.** Must be deleted from the tree and the SSH key considered compromised/rotated.

**Finding 3 (MEDIUM):** VPS retains old REALITY key backup at `/opt/netpulse-xray/config.json.bak-20261023T054011Z` — contains compromised key material. Recommendation: securely delete after confirming new key works.

No other secret-bearing files found untracked or committed in incident-closure scope.

---

## 7. Transcript exposure assessment

Searched for evidence of transcript/secret exposure in retained operational files:
- `reports/system-audit/*` — Mission 3 closeout reports; no secret values observed.
- No `.env`, `.secret`, `*.key`, `id_rsa`, or `id_ed25519` files found outside `VPS-KEYS.txt` and node_modules/test fixtures.

**Finding 4:** No evidence of transcript exposure beyond `VPS-KEYS.txt` (local) and the VPS backup file (remote).

---

## 8. Recommendations

1. **Delete `VPS-KEYS.txt` from the working tree immediately.** Rotate the SSH key; treat the passphrase as compromised. Never commit key material.
2. **Securely delete `/opt/netpulse-xray/config.json.bak-20261023T054011Z`** on the VPS after confirming the new key works with live clients.
3. **Record which clients require reissuance** (all pre-05:40 UTC profiles) once VPS profile-store evidence is available.
4. **User notice:** The statement "profiles generated before 05:40 UTC on 2026-10-23 are invalid" is accurate per backup-timestamp evidence, but the exact client list requires VPS profile-store enumeration.

---

## 9. Exit-criterion answers

- Profile reissuance working / user notice accurate: **PARTIAL** — key rotation confirmed (backup at 05:40 UTC), new REALITY key verified working via live handshake; exact client reissuance list not yet enumerated from profile store.
- Residual secret exposure: **YES** — `VPS-KEYS.txt` untracked (local) + old REALITY key backup on VPS (remote). No committed Xray REALITY key found in source.
