# Azure Trusted Signing — remaining setup steps

The pipeline is fully wired and **the machine-side tooling is installed and
verified**. What remains is account-side work only the account owner can do
(Azure portal + identity validation). This document is the exact checklist.

## Already done on this machine (verified)

| piece | state |
|---|---|
| `scripts/lib/signingIdentity.mjs` azure route | resolves, generates the metadata JSON from four env values |
| signtool (Windows SDK Build Tools) | installed per-user at `%LOCALAPPDATA%\NetPulse\signing\sdk\bin\10.0.28000.0\x64\signtool.exe`; the resolver's auto-discovery also covers this path |
| `Azure.CodeSigning.Dlib.dll` (Artifact Signing client 1.0.128) | installed at `%LOCALAPPDATA%\NetPulse\signing\dlib\bin\x64\Azure.CodeSigning.Dlib.dll` |
| dlib invocation | verified: signtool loaded the dlib and reached Azure auth (a placeholder-account sign attempt hangs on interactive browser login — proof the local wiring is correct, since the failure is credential-side, not setup-side) |
| release gate | `NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1` fails any build whose signature is not `class=trusted` |

## What only the account owner can do

1. **Azure subscription** — create one (or use an existing) at
   <https://portal.azure.com>. Trusted Signing needs a subscription with the
   `Microsoft.CodeSigning` resource provider registered
   (`az provider register --namespace Microsoft.CodeSigning`).
2. **Trusted Signing / Artifact Signing account** — portal → Create a
   resource → *Trusted Signing*. Pricing: ~$9.99/month base.
3. **Identity validation** — one-time KYC: legal name, address, phone.
   Individuals are supported in US/CA only; organizations in US/CA/EU/UK/JP/
   KR/SG/CH/NO/IL/AU/NZ. Approval is usually minutes, can take days.
4. **Certificate profile (Public Trust)** — inside the account, create the
   profile. This is what makes Windows trust the signature.
5. **Grant sign permission** — your user (or a service principal) needs the
   *Trusted Signing Certificate Profile Signer* role on the profile.

## Then wire the pipeline (three ways, pick one)

```bash
# Option A — interactive (this machine, az CLI installed and `az login` done):
export NETPULSE_SIGN_AZURE_ENDPOINT="https://<region>.codesigning.azure.net/"
export NETPULSE_SIGN_AZURE_ACCOUNT="<account name>"
export NETPULSE_SIGN_AZURE_PROFILE="<profile name>"
export NETPULSE_SIGN_AZURE_CERTIFICATE="<cert name>"

# Option B — service principal (CI / unattended):
#   az ad sp create-for-rbac --role "Trusted Signing Certificate Profile Signer"
# then set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET — the dlib's
# DefaultAzureCredential picks them up automatically.

# Option C — hand-written metadata file:
export NETPULSE_SIGN_AZURE_METADATA="/path/to/metadata.json"
```

Plus the release gate:

```bash
export NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1
npm run desktop:package
```

The endpoint is region-specific — copy it from the account's overview page
(e.g. `https://eus.codesigning.azure.net/`).

## How to verify a build is truly trusted

```bash
node scripts/sign-release.mjs --verify-only --require-trusted \
  "$LOCALAPPDATA/NetPulse/netpulse-desktop.exe" \
  "$LOCALAPPDATA/NetPulse/uninstall.exe"
```

`status=Valid class=trusted` is the pass — SmartScreen stops warning once the
signed builds accumulate reputation (usually days to weeks of downloads).

## Honest state

Until the account exists, releases ship self-signed (current behavior,
documented in every release notes since v1.0.0). Nothing in this repo needs
to change the day credentials land — set the env vars and the same pipeline
that produced v1.0.0/v1.0.1 produces trusted-signed artifacts.
