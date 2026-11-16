# FABLE — VPN Engine Review

## 1. Engine inventory (as built)

| Engine | Claim | Reality check | Verdict |
|---|---|---|---|
| **xray / sing-box / v2ray** (proxy cores) | Local core tunnel from tested public nodes; optional system proxy or TUN-ish route exclusions | `engineManager.ts` installs from official GitHub releases with pinned/sidecar SHA-256 + `<core> version` self-check; `proxyCores.ts` builds args/config; `proxyTunnel.ts` verifies traffic through the CONNECT inbound via `cdn-cgi/trace` before `active`; crash → `down` + bounded reconnect (3, backoff); stop always cleans up (kill core, delete temp config, restore previous proxy) | **GENUINE** |
| **Hysteria** | Same as cores | Same install pipeline (raw asset, `hashes.txt`); `probeBinaryVersion` tries `version` then `--version` (urfave/cli quirk handled) | **GENUINE** |
| **Aether** | TUN-mode censorship-circumvention engine | `aetherProvider.ts` (976 L) + `tunClaim.ts` + elevation broker staging config with SHA-256; verified via trace through TUN; install path with `.sha256` sidecar | **GENUINE** |
| **WireGuard profiles** | Import wg profiles, connect, verify | `vpnService.ts` key validation (`isValidWgKey`, script-directive scan), `parseWgInterfaceNames` from dump output, `verifyConnect()` live-status read; self-test TCP-probes the resolved endpoint IP | **GENUINE** (interface up ≠ verified exit — and the UI reflects that distinction via `verification: failed → "not through the tunnel"`) |
| **Share-link parsers** | vless/vmess/trojan/ss/hysteria2 | Parsers present and unit-tested (`parseVlessUri` … `parseHysteria2Uri`); `materializeSingboxConfig` handles secret templating | **GENUINE** |

## 2. Lifecycle conformance (VALIDATE → PREPARE → START → VERIFY → MONITOR → STOP → CLEANUP)

- VALIDATE: engine presence (`findEngineBinary` refuses with `engine_unavailable`), key/secret validation, config parse.
- PREPARE: temp config write, ephemeral inbound port, kill-switch **pre-arm before** proxy write (crash-safe ordering — verified in `killSwitch.ts` + `proxyTunnel.ts` deps).
- START: `startCore()` process spawn, `windowsHide`, no shell.
- VERIFY: exit-IP trace through the tunnel; **process launch is never reported as connected** — `ProxyTunnelStatus.state` only reaches `active` after proof. This is the single most important property and it holds.
- MONITOR: core `close` handler → `down` + realtime event + bounded auto-reconnect; `vpnWatchdog.ts` for profile-based tunnels.
- STOP/CLEANUP: stop path kills process, deletes temp config, restores previous proxy even on failure paths; TUN path unclaims routes.

## 3. TUN vs system proxy

- TUN mode does **not** silently modify system proxy settings: proxy writes are explicit, ordered after pre-arm, and restored on stop/drop (kill switch fail-closes to a sink when the user enabled it). Applications ignoring the system proxy are outside the guarantee — and the code says so in the status instead of overclaiming.

## 4. Windows-specific correctness

- UAC: single elevation broker path, descriptor integrity via SHA-256 of staged config, loopback handshake for pending ops — no scattered privilege requests.
- Path handling: per-user data dir via `paths.rs` (single resolver), cores in per-user drop-in dir; temp extraction in `os.tmpdir()` with cleanup in `finally`.
- Process hygiene: `windowsHide`, `shell:false` everywhere verified in engine/tunnel spawn code.

## 5. Issues and recommendations

| ID | Finding | Severity | Recommendation |
|---|---|---|---|
| V-01 | Two VPN stacks in one app: profile-based (`vpnService`) and node-based (`proxyTunnel`) with separate status DTOs the UI must reconcile (`VpnPage` handles both). Works, but double the failure surface. | MEDIUM | Keep; document the union status. Do not merge hastily — the trust models differ (own profile vs tested public node). |
| V-02 | sing-box pins are a maintenance contract: new releases require manual digest pinning or installs are refused. Correct security tradeoff, but it means engine updates **stop working silently until someone pins**. | MEDIUM | Add a UI-visible "new release unpinned" state (data exists: `EngineReleaseCheck.latestTag` vs pin table) so the refusal is explainable to the user. |
| V-03 | Version cache TTL 30 s means a freshly-installed engine may appear absent in the UI for up to 30 s unless `force` is passed. | LOW | Pass `force: true` after install (verify whether route does; if not, one-line fix). |
| V-04 | `extractFileFromZip` hand-rolls zip parsing (stored/deflate only). For the expected inputs (GitHub release zips) this is fine and avoids a dependency; document the limitation. | LOW | Keep; add a comment + test for zip64 absence (large archives unsupported — acceptable, cores are < 40 MB). |
| V-05 | Reconnect limit default 3 with backoff: after exhaustion state stays `down` with an error — correct (no infinite retry storms). | — | Keep. |
| V-06 | `cores/` and `aether/` install dirs live in-repo for this dev checkout; production uses the per-user data dir (`NETPULSE_CORES_DIR` override exists for tests). Ensure package scripts never bundle the dev `cores/` dir. | LOW | Verify `desktop-package.mjs` exclusion list; document. |

## 6. Verdict

No engine is fake. The lifecycle discipline (verify-before-active) is implemented and enforced at the state machine level. The Windows system layer (elevation, DPAPI, updater) is narrow and well-tested. Remaining work is UX transparency (V-02) and packaging hygiene (V-06), not correctness.
