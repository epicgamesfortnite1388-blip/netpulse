# v1.0.0

*First stable release. Everything since v0.2.2 — the VPN system, the security
model, the node subsystem, and the packaging/updater pipeline — finalized and
verified end to end.*

## VPN

- **Four engine families, one surface** — xray, sing-box, v2ray and Aether run
  as driven local cores; WireGuard and OpenVPN as system tunnel providers. The
  VPN area is split into per-engine surfaces with a premium Aether experience.
- **TUN mode per engine** — system-wide capture gated behind a real elevation
  path: one-click elevated relaunch (single-call safe), one shared TUN gateway
  state machine, and a self-healing watchdog that re-arms the capture once
  before falling back to a blocked state. Verified live: the gateway claims
  the default route, a real trace exits through it, and stopping restores the
  machine.
- **Kill switch that holds** — fail-closed on tunnel drop, enforceable while
  TUN owns the default route; enforcement state is shown honestly per mode.
- **Nested mode** — chain two local cores so the exit address differs from the
  entry edge.
- **Real preferences** — auto-connect on app start, auto-select server by
  score, and DNS-through-VPN are implemented end to end.
- **Engine intake** — paste any V2Ray-family config, test it through a real
  core, and promote it to a VPN profile in one flow; share-links copy from
  every explorer row.

## Security

- **Per-launch daemon secret** — the sidecar's API is authenticated by an
  ephemeral secret injected by the desktop shell; no browser-observable
  credential exists.
- **Origin-gated sessions** — session issuance restricted to webview origins;
  short default TTL.
- **Verified engine installs** — cores download only from official release
  hosts, verify published SHA256 digests, and validate by spawning
  `<core> version`.
- **Untrusted-input guards** — imported configs parse at one boundary;
  SSRF-guarded target resolution refuses hostname-based private addresses.

## Nodes & data

- **Real-only results** — every count, latency and quality number comes from a
  stored measurement; failures report the stored record, and the toast, the
  row and the history always agree.
- **Honest geo pipeline** — IP-evidence geolocation with an anycast/edge-fabric
  guard, per-country plausibility gate, and user overrides.
- **Server-side paging** over the full node database with engine
  attribution (Runtime column, filter, sort).

## Packaging & updates

- **In-app updater, proven end to end** — polls a signed feed, shows release
  notes, installs and restarts. The update chain (check → download →
  signature verify → unattended install → relaunch) was driven live on the
  installed app, twice; loopback feed requests bypass the system proxy.
- **Signed installers** — Authenticode signing with timestamp retry, signed
  uninstaller, and a signature-trust gate that classifies, never assumes.
- **Deterministic artifact feed** — the updater zip is written by a
  deterministic writer (STORED method the plugin accepts) and minisign-verified
  against the key baked into the app.

## Honest limitations

- The installers are **self-signed**: Windows SmartScreen shows the publisher
  as unverified until a trusted code-signing certificate (Azure Trusted
  Signing route is wired) is provisioned. Tamper detection is intact.
- A real VPN tunnel handshake needs the user's UAC consent by design; the
  app surfaces the OS's own errors verbatim and never fakes a connected state.
- The bundled cores are not shipped with the app (licensing/size); the engine
  manager installs them on demand from official releases.
