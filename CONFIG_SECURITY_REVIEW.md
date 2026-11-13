# Configuration Security Review

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Verdict:** the untrusted-input posture is defensible and in places strong (SSRF-guarded fetch, no execution of fetched content, DPAPI-backed secret vault, no endpoint addresses on the wire). The **privacy posture of a free public node remains weak by nature**, and the product must keep saying so. One real SSRF finding was found and **fixed** in this evaluation.

---

## 1. Threat model

| # | Threat | Who could do it | Impact if unmitigated |
| --- | --- | --- | --- |
| T1 | Malicious configuration file executes code | Feed publisher | Arbitrary code execution on the client |
| T2 | SSRF via a user-supplied source URL or node-test IP | Local API caller / malicious UI content | Access to loopback, LAN, cloud metadata |
| T3 | Credential exfiltration from stored configs | Local attacker, backup sync, support bundle | Account takeover of user-owned servers |
| T4 | Secret leakage into logs / analytics / responses | Bugs, verbose logging | Same as T3, wider blast radius |
| T5 | Endpoint impersonation / wrong server | Network attacker, hostile feed | Traffic sent to an unintended operator |
| T6 | Operator surveillance of metadata | Node operator | Knowledge of who talks to whom, when |
| T7 | Malicious link or file in a feed | Feed publisher | Phishing, drive-by, parser exploit |
| T8 | Downgrade to insecure transport | Config with `allowInsecure`, weak TLS | Plaintext or unauthenticated tunnel |
| T9 | Dead/malicious node used as a "working" one | Anyone | False sense of privacy; traffic to unknown party |
| T10 | Kill-switch / leak failure on disconnect | Client bug | Real IP exposed |

---

## 2. Controls in place

| Threat | Control | Where |
| --- | --- | --- |
| T1, T7 | Fetched content is **data only**. No `eval`, no shell, no dynamic import of fetched bytes. Parsers are pure functions over strings. | `nodeParsers.ts`, `nodeSourceRegistry.ts` |
| T2 | `assertPublicHttpUrl()` rejects non-HTTP(S), loopback, private, link-local, multicast and metadata addresses before any fetch. Node-test `ip` overrides go through `resolveTarget()`. | `nodeSourceRegistry.ts`, `nodesService.testNode` |
| T3 | AES-256-GCM ciphertext at rest; master key in **Windows Credential Manager**, DPAPI-protected; no key file beside the data. Per-user by design — a copied data directory does not open. | `vpn/keychain.ts`, `vpn/vpnService.ts` (`FileSecretVault`), `nodeSecretVault.ts` |
| T4 | Node DTOs omit credentials and addresses (`endpoint: undefined`, `probedIp`/`testEndpoint` withheld); events record node **ids** and counts, not links; identity TOML never logged. | `nodeView.ts`, `routes/vpn.ts`, `routes/nodes.ts` |
| T5 | Certificate validation by the core; `allowInsecure` configs are **refused** (`engine_unavailable`) rather than silently downgraded. | `proxyCores.ts` (`engineSupportsConfig`) |
| T6 | Explicit per-endpoint warning; trust categories; user authorisation before first use. | `smartConnect.ts`, UI |
| T8 | Insecure/ambiguous profiles rejected at compatibility check; no option to bypass verification. | `proxyCores.ts` |
| T9 | Trust is **time-stamped evidence**, not a badge: `verdict` requires a recent proxy probe that carried traffic; stale evidence ages out (`VERIFIED_WINDOW = 2h`). | `smartConnect.ts` |
| T10 | Kill switch with bypass-rule awareness; negative controls prove "port open" is not "connected". | `killSwitch.ts`, `reports/accounting/NEGATIVE_CONTROLS_2026-11-03.md` |

---

## 3. Findings

### F1 — SSRF in a duplicate discovery module (HIGH, **FIXED**)

`apps/api/src/services/config-discovery/discoveryService.ts` (added 2026-11-03) accepted a source URL from `POST /api/config-discovery/sources` and passed it straight to `fetch()` with no address validation. It also had no persistence, dedupe, rate limit or compatibility check.

**Fix:** the module and its `/api/config-discovery/*` routes were **deleted**. The hardened `/api/v1/sources` path — which validates through `assertPublicHttpUrl()` and stores provenance — is now the only discovery surface. Typecheck and the full suite pass after removal.

### F2 — Aether identity file contains a private key and access token (MEDIUM, **MITIGATED**)

`aether/aether-masque.toml` holds `access_token`, `key_pem`, `wg_private_key`, `cert_pem`. It is a credential.

**Mitigation:** the entire `aether/` directory is git-ignored (`.gitignore` lines 115–118), identity files are created `0600` where the platform honours it, and the provider never logs their contents.
**Residual:** the file sits in plaintext in the install directory. A user who copies that folder copies the device identity. Encrypting it through the same vault is a reasonable next step, not yet implemented.

### F3 — `allowInsecure` configurations (MEDIUM, **REJECTED BY DESIGN**)

Xray 26.x refuses `allowInsecure`; 6 of 60 sampled configs hit this. That is correct behaviour: accepting them would mean skipping certificate validation.

### F4 — Free-node operator visibility (HIGH by nature, **DISCLOSED**)

A public node's operator can observe connection metadata (source IP, SNI, timing, volume) and, depending on the protocol, more. TLS success proves the *endpoint* answered with a valid certificate for *some* name — **it does not prove the operator is trustworthy, that logging is off, or that the endpoint is not a honeypot**.

**Disclosure:** trust categories, a warning before first use, and an explicit statement in the UI and reports that free configurations are unsuitable for banking, account recovery or confidential work.

### F5 — IPv6 / UDP leak coverage is incomplete (MEDIUM, **PARTIAL**)

`reports/accounting/LEAK_TEST_2026-11-03.json` shows IPv4 egress verified through the tunnel (`104.28.197.9`) and IPv6 working *through* the tunnel, but the host has no direct IPv6 egress to test against, and the SOCKS listener accepts TCP only, so **UDP/QUIC leak behaviour is unmeasured**. This is a real gap for QUIC-heavy traffic.

### F6 — Aether TLS pinning off by default (MEDIUM, **DOCUMENTED**)

`aether/run6.log`: `tls verification: disabled (--tls-verify enables pinning; on by default with --team)`. NetPulse does not pass `--team`, so the inner WireGuard identity is not pinned by that flag. Documented rather than silently changed, because `--team` changes the product's identity model.

### F7 — Discovery surfaces the endpoint of a third-party node (LOW, **ACCEPTED**)

The node explorer exports share links for nodes the user already imported, because that is the only way to promote one into an engine. The API deliberately withholds `host`/`port` from list responses; export is an explicit single-node action.

---

## 4. What a successful test does and does not prove

| Observation | Proves | Does **not** prove |
| --- | --- | --- |
| TCP connect succeeds | Something listens on that port | That it is a proxy |
| TLS handshake + valid chain | The endpoint holds a cert for that name | That the operator is honest or logging-free |
| SOCKS/CONNECT accepted | A proxy speaks the protocol | That traffic reaches the destination |
| HTTP 200 from a probe URL through the tunnel | Traffic traversed the node **at that moment** | That it will work tomorrow, or that it is safe |
| 25-minute survival (6/7) | Short-window stability | One-hour survival (unmeasured) |

This is why the trust ladder is temporal and why `SmartConnect` refuses to call an untested node verified.

---

## 5. Residual risk register

| Risk | Severity | Status |
| --- | --- | --- |
| Free node operator surveillance | High | Inherent; disclosed, not solvable by the client |
| Aether identity file plaintext on disk | Medium | Mitigated by ignore rules; encryption not implemented |
| UDP/QUIC leak matrix unmeasured | Medium | **OPEN** |
| No cert pinning for Aether without `--team` | Medium | Documented; product decision pending |
| sing-box absent → Hysteria2/TUIC unusable | Medium | **OPEN** (upstream release lookup) |
| GitHub API quota on install/update | Low | Fallback URL exists, not primary |
| Iran-ISP behaviour unverified | High | **OPEN** — the central unknown |

---

## 6. Recommendations, in priority order

1. Encrypt `aether/aether-masque.toml` through the existing vault (same envelope, per-user key).
2. Extend the leak harness to UDP/QUIC and to a dual-stack host, so F5 stops being a gap.
3. Decide explicitly whether NetPulse passes `--team`/`--tls-verify` for Aether, and document the trade-off in the UI.
4. Fix the sing-box pin so Hysteria2/TUIC are not structurally unavailable.
5. Obtain an Iranian vantage for the field run; until then, do not market Iran readiness.
6. Add a periodic "trust decay" job that demotes `TRAFFIC_VERIFIED` rows automatically, so the UI cannot show yesterday's success as today's guarantee.
