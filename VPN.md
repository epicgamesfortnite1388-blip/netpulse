# VPN

NetPulse treats the OS VPN stack as the source of truth. The UI never invents connection
state: if no provider binary is installed, `supported` is `false` and the connect button
explains what is missing.

## Provider abstraction

```
VpnProvider (interface)
├── WireGuardProvider   — drives wireguard.exe / wg-quick when installed
├── OpenVPNProvider     — drives openvpn with a generated config file
└── CustomProvider      — user-supplied command profile (explicitly opt-in)
```

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

The service interfaces define capabilities for kill switch, DNS-through-VPN, and split
tunneling. Where the platform exposes them (WireGuard `AllowedIPs=0.0.0.0/0` +
`Table=off` policies, per-profile DNS), the profile import records them; where the
environment cannot enforce them, NetPulse reports them as **not enforced** rather than
pretending. Automatic reconnect re-invokes the provider connect path on observed
drop events during monitoring.

## Adding a provider

1. Implement `VpnProvider` in `apps/api/src/vpn/` (or a new module).
2. Register it in the provider registry factory next to WireGuard/OpenVPN.
3. Add contract tests: availability detection on a clean host, connect/disconnect
   against a stub binary, secret isolation (import → assert no key material in
   responses/history).
