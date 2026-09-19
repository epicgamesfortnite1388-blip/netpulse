# VPN

NetPulse treats the OS VPN stack as the source of truth. The UI never invents connection
state: if no provider binary is installed, `supported` is `false` and the connect button
explains what is missing.

## Provider abstraction

```
VpnProvider (interface)
├── WireGuardProvider   — drives wireguard.exe / wg-quick when installed
├── OpenVPNProvider     — drives openvpn with a generated config file
├── SingBoxProvider     — drives the app-managed sing-box core (proxy + TUN)
└── AetherProvider      — drives the Aether core (SOCKS bring-up, discovery)
```

Beside the providers sits the **proxy tunnel** (`services/proxyTunnel.ts`): one
long-lived local core (xray / sing-box / v2ray) the system can be routed
through, with verified exit IP, crash detection and an optional **TUN mode**
in which the gateway claims the default route. Nested mode chains two cores
so the exit address differs from the entry edge.

Every core binary — provider or tunnel — spawns through the shared
**core-process owner** (`services/coreProcess.ts`): one spawn/readiness/
cleanup path, so a leaked or half-started core looks the same everywhere and
cleanup has a single implementation.

Each provider implements:

```ts
interface VpnProvider {
  info: VpnProviderInfo;                 // id, name, capabilities, availability
  init(): Promise<void>;                 // detect binaries, refresh availability
  importProfile(input): Promise<ImportedProfile>;
  connect(profile): Promise<VpnStatus>;
  disconnect(): Promise<VpnStatus>;
  status(): Promise<VpnStatus>;
}
```

`VpnStatus` is always the **observed** state (process presence + interface/route
observation where the platform allows). `connected: false` until a real tunnel is
confirmed.

## Profile import

Profiles (WireGuard INI, `.ovpn`) are parsed server-side:

- Extracted metadata: endpoint, public-key fingerprint, allowed IPs, DNS settings.
- Private keys and credentials go to the **secret vault** — never the database, API
  responses, or logs. Profile endpoints return summaries only.
- Config files are written under the data directory with restrictive permissions.

## Secret vault

`FileSecretVault` (apps/api/src/vpn/vpnService.ts) encrypts secrets with AES-256-GCM
using a machine-local key file (mode 0600). Vault files use hashed filenames (Windows
does not allow `:` in names). A packaged build should swap this for the OS keychain;
the vault is a single class behind one interface.

## Connect / disconnect flow

1. UI calls `POST /vpn/connect { profileId }`.
2. API resolves the profile, reads the secret from the vault, and invokes the provider.
3. The provider spawns the binary (argv-array, no shell) and polls its status.
4. `GET /vpn/status` reflects the real state; `GET /vpn/connections` holds history.

## Security posture (kill switch, DNS protection, split tunneling)

The **kill switch** (`services/killSwitch.ts`) is a real enforcement layer,
not a setting: when the tunnel drops it fails traffic closed (system-proxy
sink in proxy mode, route-level hold under TUN) and remembers the user's
pre-block value so the restore is exact. Under TUN, capture and hold share
one state machine with a bounded automatic re-arm; a failed re-arm surfaces
as an explicit degraded state in the UI — never a silent fall-back to the
direct path. Where the environment cannot enforce protection, NetPulse
reports it as **not enforced** rather than pretending. Automatic reconnect
re-invokes the provider connect path on observed drop events during
monitoring.

## Adding a provider

1. Implement `VpnProvider` in `apps/api/src/vpn/` — spawn through the shared
   core-process owner, not `child_process` directly.
2. Register it in the provider registry factory next to WireGuard/OpenVPN.
3. Add contract tests: availability detection on a clean host, connect/disconnect
   against a stub binary, secret isolation (import → assert no key material in
   responses/history).
