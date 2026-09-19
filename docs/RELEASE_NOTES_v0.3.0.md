# v0.3.0

*Everything since v0.2.2 — 29 changesets, ~31,700 lines added across 205 files.*

## VPN

- **Aether engine** — a fourth tunnel provider alongside xray / sing-box / v2ray: the real Aether binary is spawned, its SOCKS bring-up is watched, and the provider reports honest states (no invented "connected"). Its UI is a dedicated premium surface.
- **One-click proxy tunnel** — start a system tunnel through any tested node from the VPN surface, with auto-pick from the tested pool and verified exit IP.
- **TUN mode** — system-wide tunnel per engine, gated behind a real elevation path: one-click elevated relaunch (single-call safe — the Rust command arms and quits in one step, so no dead-end UAC prompt), one shared TUN gateway state machine, and a self-healing watchdog that re-arms the capture once before falling back to a blocked state.
- **Kill switch that holds** — fail-closed on tunnel drop, enforceable while TUN owns the default route; the enforcement state is shown honestly per mode, and an unskippable hold surfaces in the UI if arming fails after a verified capture.
- **Nested mode** — chain two local cores so the exit address differs from the entry edge; chains exclude only the entry hop.
- **Real preferences** — auto-connect on app start, auto-select server by score, and DNS-through-VPN are implemented end to end (no decorative switches), and the VPN split divides cleanly into xray / sing-box / v2ray / Aether / WireGuard / OpenVPN surfaces.
- **Tunnel hardening** — stop/restart race fixed, the user's pre-existing system proxy is preserved on every failure path, a CONNECT socket leak is closed, and crash recovery marks stale rows interrupted before hydration.

## Security

- **Origin-gated sessions** — session issuance is restricted to webview origins; a random local webpage can no longer get a session. Default session TTL shortened.
- **Per-launch daemon secret** — the sidecar's API is authenticated by an ephemeral secret injected by the desktop shell over stdin; no credential that satisfies the local API exists anywhere a browser can request one.
- **Engine installs verified** — cores are downloaded only from official release hosts, verified against published SHA256 digests before extraction, and validated by spawning `<core> version`; signature trust is classified explicitly, never assumed.
- **Untrusted-input guards** — SSRF target resolution (`resolveTarget`) refuses hostname-based private addresses; imported configs are parsed at one boundary with injected values refused.
- **Tunnel hardening (security side)** — proxy-preservation on failure, stop/restart race elimination, and socket-leak fixes audited with regression tests.

## UI

- **3D globe** — the 2D canvas map is replaced by a real interactive Earth (three.js): natural grab-the-globe drag, correct fly-to facing, honest node-DB pins with screen-space picking, cluster zoom, and accuracy tests pinning known endpoints to the right continent.
- **Node explorer** — Runtime column/filter/sort showing which core (xray / sing-box / v2ray) last tested each node; server-side paging over the full database (beyond the old 2,000-row window); share-link copy on rows; engine-attribution in the history timeline; pasted configs flow through the engine-intake card straight into test and promote-to-profile.
- **Foldable cards app-wide** — one card system (`Card fold` + `useDisclosure`) with persistent per-card state, truthful folded summaries, and Collapse/Expand-all toolbars across dashboard, nodes, VPN, diagnostics, settings, and every remaining page.
- **VPN surfaces rebuilt** — shared surface primitives, an admin-access panel, discovery and gateway-memory dashboards, and an engine manager with one-click install/update from official releases.

## Nodes & data

- **Honest geo pipeline** — transit-router locations refused in the map panel, explorer geo re-check, confidence legend with ring-encoding tooltip, geo-provider preference with automatic failover.
- **v2ray (v2fly) as a third local test core**, with config-generation, vault-persistence, and Shadowsocks-parser fixes so v2ray-family nodes actually test.
- **Real-only results** — failed probes report failure from the stored record (toast/row/history agree); counts, latencies and quality come from measurements, never fabrication.

## Packaging

- Installer filename derived from `tauri.conf.json`; sidecar boot, migration and version-stamp gates in the package pipeline; fresh install verified through the real exe (paste→test→promote, node test, tunnel start/stop with verified exit IP).
