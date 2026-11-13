# Aether Architecture — implementation, provenance, and the boundary NetPulse must respect

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2`
**Evaluation date:** 2026-11-04
**Verdict:** Aether is a **real, native Windows userspace WARP/MASQUE core**, installed from verified upstream releases and integrated as a process + local SOCKS5 endpoint. It is **not** a share-link engine: it cannot dial VLESS/VMess/Trojan/Shadowsocks/Hysteria2/TUIC configurations. NetPulse therefore runs **two engine families** and routes each configuration to the family that can actually speak it.

---

## 1. What Aether actually is

Aether is a Rust userspace WARP core built around MASQUE (HTTP/3 and HTTP/2), with WireGuard and nested-tunnel modes. It discovers reachable Cloudflare edges, validates the data plane end-to-end, and exposes an **unauthenticated local SOCKS5 proxy** for applications.

| Property | Value | Source |
| --- | --- | --- |
| Implementation | `CluvexStudio/Aether` (canonical repository) | `aether/Cargo.toml` → `repository = "https://github.com/CluvexStudio/aether"` |
| Version integrated | **2.4.0** | `./aether/aether.exe --version` → `aether 2.4.0` |
| Language / edition | Rust, 2021 | `aether/Cargo.toml` |
| Licence | **AGPL-3.0-only** | `LICENSE` (GNU AGPL v3) + `Cargo.toml` `license` field |
| Authors | CluvexStudio | `Cargo.toml` `authors` |
| Build inputs | Rust stable, C/C++ compiler, CMake, **`quiche` checked out beside `aether/`** | README "Build" |
| Binary layout | `lib` + `staticlib` + `cdylib` + `bin` | `Cargo.toml` `[lib]`/`[[bin]]` |

### Native libraries that matter

From `aether/Cargo.toml` at the pinned commit:

- `quiche` (path `../quiche/quiche`, features `boringssl-boring-crate`, `qlog`) → QUIC/HTTP-3 stack.
- `boring` 5.3 / `tokio-boring` 5.3 → BoringSSL bindings.
- `smoltcp` 0.14 (`medium-ip`, `proto-ipv4`, `proto-ipv6`, `socket-tcp`, `socket-udp`) → the userspace TCP/IP stack behind the tunnel.
- `boringtun` 0.7 → WireGuard.
- `h2`, `http`, `bytes` → HTTP/2 MASQUE.
- Optional `arti-client`, `tor-chanmgr`, `tor-rtcompat`, `liblzma`, `tracing-subscriber` behind the `tor` feature.

Consequence for packaging: the shipped binary is self-contained for the user, but **rebuilding** it requires BoringSSL/CMake and a sibling `quiche` checkout. NetPulse does not rebuild it; it installs a signed release asset.

---

## 2. The PattNG relationship (mission-mandated inspection)

`patterniha/PattNG` is a **v2rayNG fork for Android**, described as "v2rayNG fork for Iranians", whose stated changes include *"اضافه شدن هسته‌ی aether"* — "addition of the aether core".

Inspected facts:

| Fact | Evidence |
| --- | --- |
| PattNG default branch is `my-releases`, not `master` | `GET /repos/patterniha/PattNG/contents/` → `"ref":"my-releases"` |
| `my-releases/.gitmodules` declares `aether` | `path = aether`, `url = https://github.com/patterniha/Aether.git`, `branch = main` |
| Pinned submodule commit | **`d58f9d568083129ce2c767c85054021eb3ee6a38`** (`GET .../contents/aether?ref=my-releases` → `"type":"submodule"`) |
| Pin update commit | `7b3133f50945f98f5e586d8fb18d5cac7848a928`, 2026-10-24, "Update aether to d58f9d5" |
| Pin commit message | fork's `main` at `d58f9d5` **is versioned 2.4.0 and not tagged yet**; based on 2.3.13 plus CluvexStudio fixes |
| Not-an-aether submodule | `master/.gitmodules` has only `AndroidLibXrayLite` and `hev-socks5-tunnel` |
| Same implementation | `patterniha/Aether` README downloads binaries from `CluvexStudio/Aether` releases and links `t.me/CluvexStudio` |

**Conclusion:** PattNG's "aether" is the same project NetPulse integrates, consumed as a **pinned submodule at 2.4.0**. `patterniha/Aether` is a fork of CluvexStudio's repository; the commit message records three fork-side fixes (psiphon tactics through `--upstream`, WARP key-fetch edge fallback, `--team` implying `--tls-verify`).

**What NetPulse installs is upstream, not the fork:** release asset from `CluvexStudio/Aether`, not a build of `d58f9d5`. Version line matches (2.4.0). **Byte identity with PattNG's pin is NOT VERIFIED** and is not claimed.

### Android

PattNG runs Aether on Android (its README references "the same HTTP/2 setup PattNG uses on Android"). NetPulse has **not** inspected PattNG's Java/shell invocation of the core, so the exact binding mechanism (spawned binary vs. `cdylib` call) is **NOT VERIFIED**. What *is* verified is that upstream ships native Android (Termux), Linux, macOS and Windows artifacts and that the core exposes SOCKS5, which is a process-level interface.

---

## 3. Runtime interface

```
aether.exe --bind 127.0.0.1:1819 --config <identity.toml> --log-level info <profile flags>
```

- **Identity/config file:** TOML holding `device_id`, `access_token`, `cert_pem`, `key_pem`, `ipv4`, `ipv6`, `wg_private_key`, `wg_peer_public_key`, `client_id`, `gateway_proxy`, `assigned_endpoint`. NetPulse keeps it at `aether/aether-masque.toml` (the whole `aether/` directory is git-ignored).
- **Transport flags:** `--masque`, `--wg`, `--gool` (WireGuard over MASQUE), `--mim` (nested MASQUE); `--h2` for HTTP/2 instead of HTTP/3; `--scan turbo|balanced|thorough|stealth|ironclad`; `-4`/`-6`/`--dual`; `--noize …`; `--no-quick-reconnect`.
- **Output:** structured log lines on stdout/stderr, then a local SOCKS5 listener.
- **Data-plane self-check:** Aether only exposes SOCKS5 after `connect-ip status: 200` and *"masque tunnel validated (end-to-end data confirmed)"* — see `aether/run6.log`.

### The boundary that shapes the product

Share links are **not** an Aether input. `AetherProvider.importProfile()` accepts only a JSON settings object (`protocol`, `scanMode`, `transport`, `ipVersion`, `noize`, `quickReconnect`) or an empty string; anything else is rejected with `invalid_config`.
A VLESS/VMess/Trojan/SS/Hysteria2/TUIC endpoint is dialled by **Xray-core** or **sing-box**, not Aether.

Thus:

| Configuration family | Engine | NetPulse path |
| --- | --- | --- |
| Aether profile (WARP/MASQUE/WireGuard/nested) | Aether | `AetherProvider` → local SOCKS5 → system proxy / TUN |
| VLESS, VMess, Trojan, Shadowsocks (xray-supported) | Xray / V2Ray | proxy core runner / proxy tunnel |
| VLESS, VMess, Trojan, SS, Hysteria2, TUIC (sing-box-supported) | sing-box | proxy core runner; profile promotion via `sing-box` |
| Hysteria2 | hysteria | only when that core is installed |

`engineSupports(engine, protocol)` is the single source of truth (`apps/api/src/services/proxyCores.ts`), and `SmartConnect` rejects a profile when no installed core can dial it rather than retrying it.

---

## 4. Lifecycle as implemented

`apps/api/src/vpn/aetherProvider.ts` (976 lines) implements:

1. **Install/update** — `installAether()` in `engineManager.ts`: GitHub release lookup for `CluvexStudio/Aether`, asset `aether-windows-x86_64.zip`, `.sha256` sidecar / `SHA256SUMS.txt` verification, extraction, then a bounded `aether -v` self-check.
2. **Initialization** — binary presence, identity directory, bind port constants (`AETHER_SOCKS_PORT = 1819`).
3. **Profile import** — JSON settings validated and stored through the provider vault; file written `0600`.
4. **Connect** — spawn with `buildAetherArgs()`, optional `[direct]` routes file from bypass rules, then **relay verification**: `portAnswering()` is *not* enough; `socks5RelayCheck()` must prove a real SOCKS5 CONNECT to a target.
5. **Traffic / exit verification** — `fetchExitIpThroughSocks()` reads the exit IP through the tunnel; `resolveThroughTunnel()` runs a DNS query over the tunnel.
6. **Network takeover** — `takeSystemProxy()` when no TUN gateway is available; `startTunGatewayFor()` when it is; split-tunnel rules preserved.
7. **Monitoring** — child exit handlers, `connectedAt`, provider `status()`, `health()`.
8. **Reconnection** — supervised by the shared watchdog; Aether's own `--no-quick-reconnect` default is exposed as a setting.
9. **Clean shutdown** — kill + wait, restore system proxy, remove routes file, clear state.
10. **Error classification** — `exitCodeLabel()` normalizes Windows' unsigned kill code (4294967295 → −1); failures map to `aether_missing` / `already_connected` / relay failure reasons.

### What counts as "connected"

Only this chain counts, and the negative controls prove it:

```
process alive → SOCKS5 port answers → SOCKS5 CONNECT relays bytes → exit IP readable through tunnel
```

Port-open alone is explicitly **not** success. `reports/accounting/NEGATIVE_CONTROLS_2026-11-03.md` demonstrates four designed failures where `portOpen: true` but `relay: false` and `exitIp: null` (blocked peer, occupied port, corrupt identity, then direct-egress fallback), **4/4 behaved**.

---

## 5. Licensing and redistribution obligations

- Aether is **AGPL-3.0-only**. NetPulse does **not** bundle or redistribute the binary; it downloads the official release at install time and verifies its published digest. That keeps NetPulse out of the "conveying a modified version" case in the normal path.
- If NetPulse ever bundles the binary in an installer, the AGPL's source-offer obligations apply to that distribution.
- AGPL §13 applies to *modified* versions operated as a network service; NetPulse is a local client and does not host Aether.
- NetPulse must keep the licence, copyright notice and a link to source with any distribution, and must not relicense the core.
- This document is engineering analysis, **not legal advice**; a redistribution decision should get a licence review.

Upstream source: <https://github.com/CluvexStudio/Aether> · mirror/fork: <https://github.com/patterniha/Aether> · PattNG: <https://github.com/patterniha/PattNG>

---

## 6. Differences from upstream and what they mean

| Difference | Effect on NetPulse |
| --- | --- |
| NetPulse consumes **releases**, PattNG consumes a **submodule commit** | NetPulse tracks tagged releases; a fix that only exists in the fork's untagged `main` is not present |
| Fork fixes: psiphon via `--upstream`, WARP key fallback, `--team` → `--tls-verify` | NetPulse passes no `--team` and does not drive psiphon, so these paths are unused |
| Windows process integration vs Android in-app core | Windows is natively supported upstream; no emulation or compatibility shim is involved |
| NetPulse adds `[direct]` routes from its bypass rule set | Keeps split tunneling truthful: bypassed destinations really are direct |

---

## 7. Honest limits

- Tunnel proofs were taken from a **non-Iranian network** (Windows host behind an existing VPN). Iran-ISP behaviour is **NOT TESTED**; the field harness exists (`npm run field:iran`) but Iran-ready remains 0/5.
- `aether/run6.log` shows `tls verification: disabled (--tls-verify enables pinning; on by default with --team)`. NetPulse's default Aether profile does **not** pass `--team`, so the inner WireGuard identity is not pinned by that flag. This is an upstream default, documented, not silently changed.
- Exit locations observed in proofs were Cloudflare WARP egresses (e.g. `104.28.197.9`, DE via FRA). Aether is a WARP client: it changes your apparent egress to Cloudflare's network, and Cloudflare is then the operator that can see connection metadata.
- Byte-for-byte equality with PattNG's pinned core was not established, and no claim of it is made.
