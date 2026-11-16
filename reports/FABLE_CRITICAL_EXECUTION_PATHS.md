# FABLE — Critical Execution Paths (traced entry point → final effect)

Each path below was traced in code this session. Statuses: VERIFIED (traced + tests green), TRACED (code read end-to-end, not live-tested here), PARTIAL (gaps noted).

## P1. Desktop boot (VERIFIED via unit tests + build)
`main.rs` setup: logging → elevation helper → single-instance lock → `spawn_sidecar()` (writes token to stdin, waits for `/healthz` on loopback) → watchdog thread → `present_main_window` → `bootstrap` command delivers `{api_base, ws_base, token, desktop, version, webview2}` to webview exactly once → webview `transport.ts` memoizes credentials.
- Failure path: sidecar exit 78 (handshake fail) → status surface shows offline state, no fake success.

## P2. Connect to node (proxy tunnel) (TRACED)
`VpnPage.tsx` connect → `POST /vpn/tunnel/start` (routes/tunnel.ts) → `proxyTunnel.startTunnel()`:
1. Resolve node + secret from vault; pick engine (`findEngineBinary` — refuses when core absent, reports `engine_unavailable`, never fake success).
2. `startCore()` spawns xray/sing-box/v2ray with generated config (ephemeral inbound port).
3. **Verification**: `fetchThroughPort(port, EXIT_TRACE_URL)` — HTTPS `cloudflare.com/cdn-cgi/trace` through the CONNECT inbound; parse `ip=`. `active` is set ONLY after traffic provably traversed the node.
4. Optional system proxy write (kill switch pre-arm → arm ordering crash-safe).
5. Crash: core `close` event → `down` + realtime event + bounded auto-reconnect.
- Nested mode: two cores, entry exit-IP and final exit-IP measured separately and compared; "exit differs from entry edge" is an observation, not an assumption.

## P3. Connect via WireGuard profile (TRACED)
`VpnPage` → `/vpn/connect` → `vpnService` → `aetherProvider`/elevation path: profile key material validated (`isValidWgKey`), elevation broker stages config with SHA-256 → UAC → tunnel interface → `verifyConnect()` (`vpnService.ts:313`) reads live status; `vpnSelfTestService` TCP-probes the resolved endpoint IP (never hostname) and reports `tunnel connected — endpoint probe skipped` honestly when already connected. UI shows `verifiedPublicIp` only when verified (`VpnPage.tsx:115`), and `Routing: not through the tunnel` when verification failed (`verification === 'failed'`).

## P4. Engine install (VERIFIED by unit tests in api suite)
`EngineManagerPage` → `/engines/install` → `engineManager.installEngine()`: GitHub release lookup (UA + Accept headers) → asset match → https download (host allowlist `github.com`/`objects.githubusercontent.com`/`release-assets.githubusercontent.com`, 60 MB cap, 120 s cap, ≤3 redirects) → digest: pin layer (sing-box, `SINGBOX_PINNED_DIGESTS`, unpinned ⇒ refuse) and/or release sidecar (`.dgst`/`hashes.txt`) → extract single expected binary via hand-rolled zip reader (stored/deflate only) → `<core> version` self-check → install to per-user cores dir. Aether variant uses `-v` and `.sha256` sidecar.

## P5. NANI desktop investigation (TRACED)
`NaniPage` → Tauri `nani_start_investigation(query)` → `investigation.rs::run_lifecycle`:
1. OBSERVE: for each registered API, `probe_api(&entry)` — real DNS (`to_socket_addrs`), TCP (`TcpStream::connect_timeout`), TLS/HTTP layer classification (`failure_classifier::classify`), each layer independent so a 401 is never "network down".
2. ANALYZE: `DiagnosticEngine` posterior update — `bayesian_update()` with per-(source,hypothesis) dedupe, -inf preserved, confidence-weighted log-likelihoods; `nani_math_select_probe` ranks probes by expected IG/cost (`diagnosis.rs::expected_information_gain` — log-space predictive outcome enumeration).
3. VERIFY: re-probe after recovery actions; `recovery.rs` plans steps gated on evidence sufficiency (`insufficient-evidence` refusals exist in API route tests).
4. Events emitted per stage on `EventBus`; replay buffer 256 entries.
- Cancellation: atomic flag checked per stage; cancelled runs emit `InvestigationCancelled` and leave no partial state presented as complete.

## P6. NANI web/shadow loop (TRACED)
`app.ts:651,897` — `NaniShadowHealthLoop.start()` runs `nani.runShadowHealthPass()` on a timer, unconditionally (no desktop-mode gate) → **runs concurrently with the Rust MonitorLoop in the desktop app** (see FABLE-ARCH-001).

## P7. Update flow (TRACED)
`updater_feed.rs`: detects loopback feed → drives `UpdaterBuilder` with `no_proxy()` (documented reqwest system-proxy bug) → plugin downloads and **verifies minisign signature against baked pubkey** → pre-kill wait (15 s) for locked files (sidecar node.exe) → NSIS install. Remote feeds keep system proxy (censorship-network consideration).

## P8. Auth/cloud session (TRACED)
webview → `cloudSync`/`keychain.ts` → DPAPI-protect refresh token + vault key via Tauri `dpapi.rs` → cloud Worker `/api/*` (D1). Desktop mode disables server-side auth routes (`NETPULSE_DESKTOP=1`, `AuthOptions.desktopMode`).

## P9. AI copilot (TRACED)
`CopilotPage` → `/api/v1/ai/ask` → cloud Worker proxy → Abystral worker `/admin/ai` with `ABYSTRAL_AI_KEY`. Unconfigured ⇒ 503, no canned responses. Local NANI explanation path is separate (`ai/` Rust module, opt-in local llama.cpp, prose-rewrite-only).

## P10. Speed test / diagnostics (TRACED)
`speedService` + `providers/speed/cloudflare.ts`: real upload/download bytes over measurement window ("never simulated" — verified comment + code shape); DNS tests via `dnsService` with resolver catalog; WebRTC leak test is browser-side `RTCPeerConnection` STUN candidates posted to `/webrtc-report` and compared against measured public IPs.
