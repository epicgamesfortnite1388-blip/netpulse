# Egress Path Root Cause — A2

**Scope:** Investigate why Xray children and Node/curl exit through different network paths on the same machine. Collect sanitized evidence for per-process/per-socket routing, interfaces/metrics, source binding, proxy env, TUN/route tables, DNS/resolver differences, parent/child env, and simultaneous timestamped requests.

**Verification performed this session:** 2026-10-23

---

## 1. Summary conclusion

**Dual-egress root cause: NOT ESTABLISHED for the development machine.** No repeatable simultaneous-request experiment was run from the dev machine (no controlled endpoint, no admin elevation, no live network capture).

Live VPS evidence confirms both Shadowsocks and VLESS REALITY egress through the VPS IP (206.1.96.89) successfully — but that is server-side egress, not the dev-machine per-process path comparison the claim concerns.

Do not attribute to DPI. Do not claim the issue is solved.

---

## 2. Code-level evidence (Vpn_app dev machine)

### 2.1 Where egress is decided (cloud/API side)

**`apps/api/src/services/egressProxy.ts`** — "the ONE place that decides how a request leaves this machine."

Resolution order (highest priority first):
1. `NETPULSE_EGRESS_PROXY` — explicit override
2. Windows system proxy (WinINET) — what NetPulse's own tunnel/external clients write
3. `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy` environment variables
4. Direct

- SOCKS5 spoken via in-process `socksConnector` (RFC 1928 "no auth"; RFC 1929 user/pass if in proxy URL). SOCKS4/4a named `SOCKS_UNSUPPORTED`, never silently direct.
- `currentProxy()` caches 3 seconds, reset on `onSystemProxyChanged`.
- `egressFetch()` asserts target is cloud origin only (`assertCloudUrl`) — not an open relay.
- `classify()` maps transport errors to `proxy_unreachable` / `direct_unreachable` / `timeout` / `tls_failed` / `socks_failed` / `socks_unsupported`.

**Tests:** `egressProxy.test.ts` (17) + `egressThroughProxy.test.ts` (5) all pass (22/22) — proxy resolution ordering and actual proxy traversal verified by unit test.

### 2.2 How Xray children are spawned

**`apps/api/src/services/coreProcess.ts`** — single owner for spawning local proxy cores (xray / sing-box / v2ray).

Key facts:
- `spawnCoreProcess` spawns with `stdio: ['ignore', 'pipe', 'pipe']`, `windowsHide: true`, `shell: false`.
- **No explicit `env` override** — child inherits `process.env` from the Node parent verbatim.
- No `localAddress` / explicit source-interface binding set on the child.
- No TUN/route-table manipulation by coreProcess itself (TUN is a separate `tunGatewayHandle` / sing-box TUN gateway path).

### 2.3 Node/curl egress

- Node `fetch`/undici calls go through `egressProxy` (system proxy / env proxy / direct).
- curl (system binary) reads its own `http_proxy`/`https_proxy`/`all_proxy` env + system proxy; not mediated by `egressProxy`.
- Xray child processes read their own config for outbound routing; they do **not** consult `egressProxy`.

### 2.4 Candidate mechanisms for divergent egress (unproven)

| Candidate | Evidence status | Notes |
|---|---|---|
| Different interface binding (explicit source IP) | Not observed in code | No `localAddress` binding found in coreProcess or egressProxy |
| TUN/route-table selection | Plausible | TUN gateway path exists (sing-box TUN, WireGuard service) but not confirmed active on dev machine |
| Proxy env vars applied to Node but not Xray children | Partially plausible | Xray children inherit `process.env` (no env scrub), but Xray reads its own config, not `HTTPS_PROXY` |
| Windows routing policy / WFP rules | Not inspectable without admin | No route-table or WFP evidence captured |
| DNS resolver differences | Plausible | Not compared |
| Parent/child env differences | Not observed | Child inherits parent env verbatim |

---

## 3. Live VPS evidence (related but distinct)

From VPS_LIFECYCLE_VERIFICATION.md (live SSH to 206.1.96.89):

- Shadowsocks via 127.0.0.1:8388 → HTTPS 200 from www.google.com, egress IP 206.1.96.89: **PASS**
- VLESS REALITY via 127.0.0.1:443 → HTTPS 200 from www.google.com, egress IP 206.1.96.89: **PASS**, REALITY handshake succeeded with derived public key

This confirms the VPS egress paths work, but does **not** resolve the dev-machine per-process divergence (Xray child vs Node/curl).

---

## 4. What remains to be done (required by exit criteria)

1. Run simultaneous, timestamped requests from an Xray child and from Node/curl to the same controlled test endpoint; record the source IP observed by the server per process.
2. Inspect route tables, interface metrics, TUN interfaces, and the parent/child environment diff on the dev machine.
3. Repeat ≥3 times and compare.
4. Distinguish the source IP observed by the server from the local destination and selected route.

None executed in this session (no controlled endpoint, no admin elevation, no live capture on dev machine).

---

## 5. Exit-criterion answer

- Dual-egress root cause established: **NO** — not established; not attributed to DPI.
