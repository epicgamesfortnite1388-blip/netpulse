# 05 — VPN Engine and Network Correctness

## Engine lifecycle

Supported engines/providers are registered in `apps/api/src/providers/registry.ts` and implemented under `apps/api/src/vpn/` (WireGuard, Aether, OpenVPN-adjacent paths, gateway/proxy tunnels) plus `cores/`. For each, config validation → translation → binary availability → process start → readiness → TUN/route/DNS → status → shutdown was traced. Standard path is honest: status is not declared connected merely because a process exists; `verifyConnect` samples public IP before and after, and the Aether path proves a SOCKS relay plus exit-IP change.

**Critical exception found and repaired: elevated WireGuard install.** The intended UAC path (UI mints op → Rust bridge validates → allow-listed `wireguard.exe /installtunnelservice <config>` → result reported) could never complete because the nonce binding was broken across three layers (DD-049, P1). Repair:
- `apps/web/src/lib/elevationBroker.ts`: `newElevationNonce()` (24 random bytes → 48 hex chars), forwarded via IPC and in `POST /vpn/connect`.
- `apps/api/src/routes/vpn.ts`: ConnectSchema requires a 16-128 alphanumeric nonce; `runElevatedWireGuardConnect` passes it to the broker.
- `apps/api/src/vpn/elevationBroker.ts`: binds the UI-supplied nonce instead of minting its own.
- `src-tauri/src/elevation.rs`: validates the nonce at the IPC boundary and builds `?opId=&nonce=` via `pending_op_url()`.
- Tests: Rust URL test (query encoding + both params), API broker UI-nonce assertion. Rust 12/0, API 12/0.

## Real connection verification — honest status

The directive explicitly forbids treating a running process as a working tunnel. In this sandbox **no live tunnel was provisioned and no system routes/DNS/proxy were altered**. Therefore:
- Process-started, TUN-ready, route-installed, DNS-operational, TCP/TLS/HTTP-success and external-egress stages were **not re-measured** this cycle.
- Prior local evidence exists in `reports/accounting/TUNNEL_STAGES_2026-11-03.*`, `DNS_TUNNEL_PROOF_2026-11-03.json`, `LEAK_TEST_2026-11-03.json`, `NEGATIVE_CONTROLS_2026-11-03.*` — used as historical context only, not as proof for this run.
- The repaired elevation path is verified at the contract and unit level only; a real UAC-approved install remains an acceptance item for a human with a Windows desktop.

## Measurement honesty

- Speed test result now carries `tunnel {connectedAtStart, connectedAtEnd, providerId}` sampled at both ends; a run straddling connect is annotated rather than silently mixed (prior cycle).
- Remaining issues: speed runs are non-cancellable (`routes/speed.ts:26-29`, DD-021) and history is not invalidated after a run (DD-037).
- Probe provenance: NANI monitor uses raw DNS/TCP sockets and `.no_proxy()` on the HTTP client (`api_intelligence/monitor.rs:54-98`), so Windows system-proxy contamination of probe evidence is **not present**. The source-text-only test at `monitor.rs:540-546` is a false-green (DD-044).

## TUN / routes / DNS / proxy

No system networking settings were changed during testing. Prior hardening (`killSwitch.ts`, `tunClaim.ts` orphan sweep, boot proxy restoration) was re-read with no new defect. Route-compare deep-link repair now resolves stored node addresses **server-side** (`routes.ts:83-94`), preserving the privacy property that private endpoints are never echoed into the webview.

## Verdict

Connection truth mechanisms remain the strongest part of the codebase. The one catastrophic gap — elevated WireGuard being unusable — is repaired and covered. Live traffic proof remains explicitly unverified in this environment.
