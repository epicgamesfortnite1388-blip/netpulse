# ULTIMATE VPN ENGINE AUDIT

**Audit date:** 2026-11-16 · Read-only source audit; no process started/stopped, no system networking changed. **[V]** verified from code · **[A]** analysis.

---

## 1. Executive summary

**No fabricated "connected" state was found in the production engine paths.** Every engine that can connect either ships a real binary or requires a real external one, spawns it with `shell:false`, verifies with live traffic (public-IP diff or Cloudflare `ip=` trace), and cleans up idempotently on every outcome. The one deliberate stub refuses honestly with `501 not_implemented`.

Two real weaknesses:
1. A failed traffic verification does **not** revoke `connected:true` (shared helper) — see Fake-function F6.
2. The standalone `SingboxProvider` proxy-mode path labels a TCP-port-accept as `verified` without proving traffic traverses the proxy.

## 2. Engine inventory **[V]**

| Engine | Source | Binary shipped | Lifecycle V/P/S/Ver/M/St/C | Verification | Verdict |
|---|---|---|---|---|---|
| xray | `services/proxyCores.ts`, `coreProcess.ts`, `proxyEngineRunner.ts`, `engineManager.ts` | Yes `cores/xray.exe` (34.4 MB) | ✅✅✅✅✅✅✅ | HTTPS via local core → Cloudflare `/cdn-cgi/trace`; `ip=`/`loc=` | **REAL** |
| sing-box (core) | same | installable (SHA-256-pinned) | ✅✅✅✅✅✅✅ | trace through CONNECT; batched inbound↔outbound pinning | **REAL when installed** |
| v2ray | `proxyCores.ts` (shares xray builder) | installable | ✅✅✅✅✅✅✅ | same runner; capability guards refuse Reality/xhttp | **REAL when installed** |
| hysteria2 | `proxyCores.ts:684-732,1000-1346` | installable | ✅✅✅✅✅✅✅ | same runner; requires vault password | **REAL when installed** |
| WireGuard | `vpn/vpnService.ts:384-768`, `elevationBroker.ts`, `elevation.rs` | external `wireguard.exe` | ✅✅✅✅✅✅✅ | `wg show all dump` contains `netpulse-wg-<id>` + IP diff | **REAL** |
| OpenVPN | `vpnService.ts:770-977` | external `openvpn` | ⚠️⚠️✅⚠️⚠️✅⚠️ | 3-second survival heuristic; `status()` = child≠null | **PARTIAL** |
| Aether | `vpn/aetherProvider.ts` | Yes `aether/aether.exe` (24.5 MB) | ✅✅✅✅✅✅✅ | real SOCKS5 handshake+CONNECT; exit IP via SOCKS5 GET | **REAL** |
| Proxy tunnel | `services/proxyTunnel.ts`, `routes/tunnel.ts` | uses cores | ✅✅✅✅✅✅✅ | `active` only after trace `ip=`; TUN verified before route | **REAL** |
| Custom | `vpnService.ts:1540-1579` | none | ❌ | throws `501 not_implemented` | **Honest stub** |
| Outline/SS/Amnezia | — | — | — | none found | **ABSENT** (SS is a protocol inside cores) |

## 3. Lifecycle trace (verified) **[V]**

**xray / sing-box / v2ray / hysteria2.** Config builders emit real core JSON/YAML. `spawnCoreProcess` uses `shell:false`, checks ports are free, polls loopback TCP readiness, captures bounded output, and `cleanup()` is idempotent (kill + recursive temp-dir delete) on *every* outcome including port clash and spawn error (`coreProcess.ts:186-370`). Readiness is explicitly "the PROCESS is up, never that traffic traverses the proxy"; the caller then performs a real HTTPS request through the port (`proxyEngineRunner.ts:156-189`). Missing binary → `engine_unavailable`, never fake success.

**WireGuard.** INI parser validates 44-char base64 keys and rejects `PostUp`/`PostDown`/script directives. Private keys are vaulted; sanitized config on disk; real config materialized to a private tmp dir and deleted on all paths. Start is `wireguard.exe /installtunnelservice` behind a UAC broker that accepts only the allow-listed `wireguard.exe`, exact `["/installtunnelservice", <config>]`, plus a nonce and SHA-256 re-verify (`elevation.rs:54-58,158-199,480-545`). Stop is `/uninstalltunnelservice`; boot sweeps stale `netpulse-wg-*` tunnels and tmp configs.

**Aether.** Real CLI flags, 120 s readiness budget (binary scans for a route first), ground truth is a real SOCKS5 greeting+CONNECT relay; on failure the process is killed and no status claims a tunnel. Exit identity fetched through the SOCKS5 proxy. TUN mode reports `active` only after a verified relay; a failed relay stops the device. Aether **skips** the system-proxy handoff when TUN is up and restores the previous proxy on disconnect/drop. Kill switch, DNS-through-tunnel, orphan sweeps present.

**Tauri layer.** `sidecar.rs` supervises the Node sidecar (not engines). `diagnostics.rs` is log redaction + support report (no connection verification).

## 4. Concrete concerns

1. **Failed verification does not revoke `connected` [V] [HIGH].** `verifyConnect` returns `verification:'failed'` ("traffic is not flowing") but spreads the original status with `connected:true` (`vpnService.ts:366-372`); `/vpn/status` selects on `connected` alone. Combined with OpenVPN's 3 s heuristic, a connection can be reported as connected without proven routing. **This is deliberate per the source comment, but conflicts with the requirement "do not report connected merely because the process started."** Requires a product decision + regression tests across all engine paths.
2. **`SingboxProvider` proxy mode calls port-accept "verified" [V] [MED].** `vpnService.ts:1472-1481` returns `verification:'verified'` after `spawnCoreProcess` resolves on TCP accept, with an honest note that proxy mode does not change the system route — but no request traverses that proxy in this path, unlike Aether.
3. **No fabricated latency [V].** `latencyMs` always comes from measured round trips (HTTPS CONNECT trace, SOCKS5 connect timing, ICMP `ping.avg`). `scripts/bench-engine-start.ts` uses a deliberately stubbed child but is explicitly a readiness-cadence benchmark, not a tunnel claim.
4. **TUN privilege handling present, not silent [V].** `tunGatewayStartRefusal()` refuses on un-elevated Windows; `routes/tunnel.ts` promises degradation with `tunError`, never a silent fake. Proxy changes in TUN mode are skipped in both Aether and proxy tunnel; boot/teardown restore the previous proxy.
5. **Resource leaks actively guarded [V].** Idempotent cleanup, 24 h stale-core-dir sweep, per-engine orphan sweeps, and OS-level assertions in `scripts/vpn-live-proof.mjs` (proxy restored, no new listener, no leaked core PID, route/adapter unchanged).

## 5. Verification scripts are real **[V]**
`tunnel-stages.ts`, `dns-tunnel-proof.ts`, `leak-test.ts`, `reconnect-test.ts`, and `vpn-live-proof.mjs` perform live SOCKS5/CONNECT/TLS/DNS exchanges and fetch real exit IPs; they require a running tunnel and fail when absent. `vpn-live-proof.mjs:538-541` explicitly states its `curl` through the OS proxy is "the check the app's own status field CANNOT fake."

## 6. Limitations of this audit
- No engine was started; runtime truth depends on binaries being installed and endpoints responding (guarded by honest `*_missing` errors).
- The OpenVPN path was not exercised against a live server; its "PARTIAL" verdict is from source.
- A real connection test must distinguish process start / interface creation / route install / DNS / reachability / app connectivity — the code does this for xray/sing-box/WireGuard/Aether via IP-diff or trace, but not uniformly (OpenVPN).

## 7. Recommendation
1. Make `verifyConnect` failure revoke `connected` (or downgrade status to `connected_unverified` that the UI must not render as green). Add regression tests per engine.
2. Bring OpenVPN verification up to the WireGuard standard (`status` should parse the management interface or verify routes, not just child-alive).
3. Make the sing-box proxy-mode path perform one real request through the proxy before returning `verified`.
