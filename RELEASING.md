# Releasing NetPulse

Runbook for producing distributable desktop releases. Everything documented here
is implemented and verified in this repository. A full Windows build + install +
runtime + uninstall/reinstall cycle was performed on this machine; remaining
gaps (code signing, notarization) are marked honestly.

## Verified Windows build (2026-09-06)

- Toolchain: Rust stable-x86_64-pc-**windows-gnu** (user-scope rustup, no admin;
  the machine has no Visual Studio/MSVC Build Tools). Tauri CLI 2.11.4 via
  `npm i -D @tauri-apps/cli`. NSIS + WebView2 bootstrapper fetched by the CLI.
- **Build from a space-free path**: `tauri-winres`/windres cannot handle the
  space in `E:\Code\Project\Vpn app`. The pipeline therefore builds from a
  space-free working copy (`C:\np-src`):

  ```powershell
  robocopy "E:\Code\Project\Vpn app" C:\np-src /E /XD target .git .data node_modules
  cd C:\np-src && npm install
  npm run build:desktop-backend
  npx tauri build --target x86_64-pc-windows-gnu
  ```

- Artifacts (copied back into `src-tauri/target/x86_64-pc-windows-gnu/release/`):
  `netpulse-desktop.exe` (5.9 MB) and
  `bundle/nsis/NetPulse_<version>_x64-setup.exe` (36 MB, NSIS, per-user;
  name derived from `tauri.conf.json` — currently 0.2.2).
- Install test: `/S` silent install to `%LocalAppData%\NetPulse`, Desktop +
  Start-Menu shortcuts, working `uninstall.exe`, `WebView2Loader.dll` present.
- Runtime test (from the installed shortcut, not dev): native window
  (MainWindowTitle "NetPulse"), WebView2 child processes, sidecar running the
  **bundled portable Node** (`...\NetPulse\backend\node.exe`), token-authenticated
  loopback API on an ephemeral port, persistent DB at
  `AppData\Roaming\app.netpulse.desktop\netpulse.db`, single-instance enforced
  on second launch, tray/close-to-tray active.
- Uninstall/reinstall test: uninstall removes the app dir + shortcuts, preserves
  user data (DB/VPN profiles/settings); reinstall boots with all data intact.

## One-time prerequisites (per release machine)

| Requirement | Why | Check |
|---|---|---|
| Node.js ≥ 22 | builds bundles, runs tests, portable runtime staging | `node --version` |
| Rust toolchain | compiles `src-tauri`. `stable-x86_64-pc-windows-gnu` works with **no admin/MSVC** (verified); `stable-msvc` + VS Build Tools is the conventional path on machines where it can be installed | `cargo --version` |
| NSIS / WebView2 bootstrapper | installer bundling (auto-downloaded by `tauri build`) | handled automatically |
| A **space-free build path** | windres (tauri-winres) fails on paths with spaces on Windows | `C:\np-src` copy step above |
| (optional) code-signing cert + env creds | Authenticode / notarization | see "Code signing" |

## 1. Version bump (single source of truth)

All manifests share the canonical version — root `package.json` drives
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the staged backend
manifest:

```bash
npm run release:version        # syncs every manifest to root package.json version
```

The sync runs automatically as part of `desktop:build`, so a release can never
ship with drifted versions. `scripts/release-distribution.test.mjs` verifies
stamp equality on every run.

## 2. Build

```bash
npm run desktop:build
```

Pipeline: version sync → API build → web production build →
`scripts/prepare-desktop.mjs` (backend bundle + pruned node_modules +
**portable Node runtime** staged into `src-tauri/backend/`) → `tauri build`
(compiles the Rust core, embeds the web dist, bundles installers).

Artifacts land in `src-tauri/target/release/bundle/`:

- `nsis/NetPulse_<version>_x64-setup.exe` — Windows installer (perMachine,
  per-user or per-machine choice at install time)
- `msi/*.msi` — enterprise-style MSI (if WiX present)
- `appimage|dmg/msi` equivalents on other platforms

### Why a portable Node runtime (not a single executable)

The backend is a Fastify app whose validator chain (ajv / fast-json-stringify)
generates and `require()`s code **at runtime** from real `node_modules`. Node
SEA's embedder `require` resolves only builtins — structurally incompatible.
`build-backend-sea.mjs` therefore stages the official MIT-licensed `node.exe`
beside the bundle: end users need **no Node installed**, and the supervisor
never falls back to a system Node in packaged builds.

## 3. Test matrix (run before signing/shipping)

```bash
npm test                 # 186 unit/integration tests (shared + api + web)
npm run lint             # eslint, exit 0
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
npm run e2e              # 28 functional checks vs the STAGED bundle (auth, DNS,
                         # ping, traceroute, nodes, Iran, gaming, CF, SSRF guards)
npm run test:release     # 18 distribution-lifecycle checks (fresh install,
                         # upgrade/migration, corrupt-DB self-heal, uninstall/
                         # reinstall data survival, offline boot, VPN state,
                         # version stamps, clean-exit flag)
npm run desktop:verify   # bundle staging, token auth 401/200, stdin-close exit,
                         # tauri.conf sanity (CSP, icons, resources, window)
npm run build            # production web + api builds
```

All must be green before tagging a release.

## 4. Code signing & notarization

### Windows — implemented and verified (Authenticode)

A complete Authenticode pipeline ships in the repo:

- **`scripts/sign-release.mjs`** — signs any artifact with SHA-256 + an RFC3161
  timestamp, then classifies what it produced. Identity resolution lives in one
  owner, `scripts/lib/signingIdentity.mjs`: `NETPULSE_SIGN_THUMBPRINT` (store
  cert) → **Azure Trusted Signing** (`NETPULSE_SIGN_AZURE_DLIB`) →
  `NETPULSE_SIGN_PFX`(+`_PASSWORD`) → local dev cert
  (`certs/netpulse-release.pfx`, password in user-only
  `%USERPROFILE%\.netpulse-signing-pw`). Flags: `--verify-only` (report, never
  modify), `--optional` (no cert configured is not an error), `--require-trusted`
  (a chain Windows does not trust is a FAILURE) — also settable as
  `NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1` for a release build. A route that is
  *configured but unusable* always fails, even under `--optional`: a broken
  signing profile must never quietly ship an unsigned build.
- **`scripts/lib/signatureTrust.mjs`** — the single owner of what a signature
  *means*, shared by the signer, the package pipeline and the release gate so
  they cannot disagree. Classes: `trusted` (chain ends in a root the OS knows —
  the only class that can earn SmartScreen reputation), `selfsigned`,
  `untrusted-root`, `bad`, `missing`. PowerShell 5.1 collapses
  `CRYPT_E_UNTRUSTEDROOT` into `UnknownError`, so signer-is-its-own-issuer is
  what identifies a self-signed build.
  `scripts/signature-trust.test.mjs` (`npm run test:signing`, a `desktop:package`
  gate) pins that contract: 48 checks, including that a missing/blank signature
  never reads as trusted and that a broken Azure profile is refused.
- **`scripts/package-signed.mjs`** — the post-build pass that makes the
  installed exe actually carry the signature. Tauri patches the exe with
  bundle type info **after** `beforeBundleCommand`, so signing there alone is
  not enough. This script signs the patched exe, rebuilds the NSIS installer
  from the generated `installer.nsi` (embedding the signed exe), promotes
  `nsis-output.exe` to the bundle path, and signs the installer. The rebuild
  also injects the uninstaller signing command (`!uninstfinalize`) so the
  generated `uninstall.exe` is signed during compilation — NSIS 3.11 does not
  append the path; the command must carry a `%1` placeholder (quotes escaped
  as `$"` in the define, `%` left bare — `$%` leaks a literal `$`). The
  helper is `scripts/sign-uninstall.ps1` (same identity resolution — store,
  Azure or PFX). Verified: installed `uninstall.exe` carries the release
  signature.
- **Build wiring** — `npm run desktop:build` = web + backend bundle +
  `tauri build`; signing happens **after** the build via
  `scripts/package-signed.mjs` (part of `npm run desktop:package`). Do NOT
  sign in `beforeBundleCommand` — Tauri patches the exe afterwards, which
  invalidates that signature (`HashMismatch`) and leaves the installer
  unsigned. `npm run desktop:sign` = sign current artifacts in place.
- **Verification gate** — `NETPULSE_REQUIRE_SIGNATURE=1 npm run desktop:verify`
  fails the pipeline if any artifact lacks a valid signature (advisory by
  default). Add `--require-trusted-signature` (or
  `NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1`) for a real release: a present but
  untrusted chain is cryptographically fine and still leaves SmartScreen
  warning, so it must fail the build rather than pass as "signed".
- **Reality check (honest):** the local dev certificate is **self-signed**, so
  Windows reports `UnknownError` ("certificate chain terminated in a root
  certificate which is not trusted by the trust provider") — the signature and
  timestamp are cryptographically intact and **tampering is detected**
  (`HashMismatch` on any byte flip, verified), but **SmartScreen warns on every
  machine**, because SmartScreen decides on the trust chain, not on the presence
  of a signature. `Get-AuthenticodeSignature` → the checksum is valid; the
  publisher is not established. No build can change that except one signed by a
  certificate whose root Windows already trusts.
- PFX/keys are git-ignored (`certs/`, `*.pfx`). Never commit signing material.

#### Getting a certificate that actually clears SmartScreen

Since June 2023 a purchased OV/EV code-signing key must live in FIPS 140-2
Level 2 hardware, so "buy a PFX and download it" is no longer an option. Two
routes work; both sign through the pipeline above unchanged.

**A. Azure Trusted Signing (no hardware token, cheapest to operate)** — the
supported default for this repo:

1. In Azure, create a **Trusted Signing / Artifact Signing account** (the
   service was renamed *Artifact Signing* in 2026) and, inside it, a
   **certificate profile** of type *Public Trust*. Identity validation (legal
   name, address, phone) is required once per account and is what establishes
   the publisher SmartScreen sees. Register the `Microsoft.CodeSigning`
   resource provider on the subscription first. Geographic limits apply to
   Public Trust identities (orgs: US/CA/EU/UK/JP/KR/SG/CH/NO/IL/AU/NZ; dev
   individuals: US/CA only) — Private Trust has none.
2. Install the two tools — **per user, no elevation needed** (already done on
   the dev machine, see below) — the **Artifact/Trusted Signing client**
   (provides `Azure.CodeSigning.Dlib.dll`; NuGet package
   `Microsoft.ArtifactSigning.Client`, formerly `Microsoft.Trusted.Signing.Client`)
   and `signtool.exe` from NuGet `Microsoft.WindowsSDK.BuildTools` (a full
   Windows SDK install also works; `findSigntool()` checks both locations).
3. Authenticate the environment (`az login`, or a service principal with the
   *Trusted Signing Certificate Profile Signer* role).
4. Export and build:

   ```bash
   export NETPULSE_SIGN_AZURE_DLIB="$LOCALAPPDATA/NetPulse/signing/dlib/bin/x64/Azure.CodeSigning.Dlib.dll"
   # (installed per-user; see docs/AZURE_SIGNING_SETUP.md for the full
   #  remaining-steps runbook — account, identity validation, profile)
   export NETPULSE_SIGN_AZURE_ENDPOINT="https://eus.codesigning.azure.net/"
   export NETPULSE_SIGN_AZURE_ACCOUNT="<account>"
   export NETPULSE_SIGN_AZURE_PROFILE="<profile>"
   export NETPULSE_SIGN_AZURE_CERTIFICATE="<certificate name>"
   export NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1   # release: fail unless trusted
   npm run desktop:package
   ```

   (Or point `NETPULSE_SIGN_AZURE_METADATA` at a hand-written metadata JSON.)
   The exe, the installer **and** the NSIS-generated `uninstall.exe` are signed
   by the same profile — `sign-uninstall.ps1` reads the resolved values straight
   out of makensis' environment.

**B. Classic CA certificate (OV/EV)** — for a CA that still issues file-based
keys (e.g. via a cloud HSM/Key Vault): import the certificate into
`Cert:\CurrentUser\My`, then set `NETPULSE_SIGN_THUMBPRINT` to its thumbprint
and `NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1`.

Verify a finished install (the same command the pipeline uses):

```bash
node scripts/sign-release.mjs --verify-only --require-trusted \
  "$LOCALAPPDATA/NetPulse/netpulse-desktop.exe" \
  "$LOCALAPPDATA/NetPulse/uninstall.exe"
```

`status=Valid class=trusted` is what clears SmartScreen. Anything else exits
non-zero and prints the SmartScreen consequence verbatim.

**Local-only workaround (not a release fix):** importing the self-signed dev
cert into `Cert:\LocalMachine\Trusted Root Certification Authorities` stops the
warning *on that machine only* — every other machine still sees an untrusted
publisher, so it must never be presented as a signed release:

```powershell
Import-Certificate -FilePath certs/netpulse-release.cer `
  -CertStoreLocation Cert:\LocalMachine\Root   # requires elevation
```

### macOS notarization

Wired for when credentials exist: `APPLE_CERTIFICATE`, `APPLE_ID`,
`APPLE_PASSWORD` env vars enable notarization. Builds without credentials are
**unsigned** — documented in release notes, never claimed otherwise.

## 5. Auto-update system (GitHub Releases feed)

Implemented: `tauri-plugin-updater` is registered in `src-tauri/src/main.rs`, the
minisign **public** key is in `tauri.conf.json` → `plugins.updater.pubkey`, and
the endpoint is **derived, never hand-typed**: `scripts/release.mjs` stamps it
from the release repository (`NETPULSE_RELEASE_REPO`, else the root
`package.json` `repository` field) as
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
Because the stamp and the publisher read the same source, the app cannot end up
polling a feed nobody uploads to.

### Activating the feed

```bash
npm run release:version -- --repo <owner>/<repo>
```

That records the slug in the root `package.json` `repository` field and stamps
the endpoint in the same run. Until it is set, `npm run test:feed` prints a note
and `release:feed` skips with an advisory — a *release* build
(`NETPULSE_REQUIRE_UPDATER_FEED=1`) fails instead, so a placeholder endpoint can
never ship. The slug is never guessed: a wrong one would point the updater at a
repository somebody else controls.

The running app is still the authority on whether an update is *offered*: it
verifies each artifact against the `pubkey` above, so a manifest published by a
third party cannot install anything.

### What a release must carry

`npm run release:feed` (run automatically by `desktop:package`, after
`package-signed`) produces three files in
`src-tauri/target/release/bundle/updater/`:

| file | what it is |
|---|---|
| `NetPulse_<version>_x64-setup.exe.zip` | the updater artifact: the FINAL signed installer, zipped (the updater unpacks it and runs the `.exe` inside) |
| `…exe.zip.sig` | its minisign signature |
| `latest.json` | the manifest the app fetches |

Attach all three to the GitHub release tagged `v<version>`. The endpoint
resolves to the *newest* release, so the released manifest must carry the
highest version.

### Why the artifact is built here, not by `tauri build`

`bundle.createUpdaterArtifacts` is deliberately **false**. `tauri build` would
zip the installer it just bundled, but `package-signed` REBUILDS that installer
so it embeds the post-bundle-patched, Authenticode-signed exe. A `tauri build`
artifact therefore contains the *pre-signature* installer — updating from it
would silently replace a signed exe with an unsigned one. Zipping the final
installer in the feed stage is what keeps the signature on the update path.

### Two encodings that will bite you

The plugin base64-decodes the `signature` field **and** the `pubkey` before
parsing them as minisign documents. The Tauri CLI already writes `<artifact>.sig`
and `<key>.pub` in exactly that encoded form, so:

- `latest.json` → `platforms["windows-x86_64"].signature` = **the `.sig` file's
  content, verbatim**. Base64-encoding it again produces a manifest every client
  rejects.
- `tauri.conf.json` → `plugins.updater.pubkey` = the `.pub` file's content.

`scripts/lib/minisign.mjs` accepts either form and normalizes, and
`scripts/update-feed.test.mjs` pins this against a real keypair and the real
signer.

### Verification before publishing (all hard-fail)

`release:feed` refuses to write a manifest unless:

1. the artifact zip **contains the installer** (otherwise an update installs
   nothing),
2. its minisign signature **verifies against the pubkey baked into the app** —
   the same check the plugin performs before running it,
3. the signature's key id matches that pubkey (a release signed with a
   different key is invisible to every installed client),
4. the signature's global comment signature verifies (catches a `.sig` whose
   trusted comment was edited after signing) — this is the check most
   reimplementations omit,
5. with `NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1`, the installer's Authenticode
   chain is verified by `scripts/sign-release.mjs` (one owner for that verdict).

### Environment

| variable | use |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key **content** (CI secret) |
| `TAURI_SIGNING_PRIVATE_KEY_PATH` | …or a path to the key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | key password, if set |
| `NETPULSE_RELEASE_REPO` | `owner/repo` override for the stamped endpoint |
| `NETPULSE_REQUIRE_UPDATER_FEED=1` | a release build: missing key or repo is fatal (otherwise the stage skips with an advisory, like the signer's `--optional`) |

Locally the key lives at `~/.tauri/netpulse.key` (outside the repo, never
committed); in CI it belongs in secrets.

### Honest state of the runtime

The feed and its verification are real. What is **not** yet built is the in-app
call: nothing in `apps/web` invokes the updater plugin's `check()`, so the app
cannot *prompt* about an update yet — it will keep running whatever version is
installed.

Tauri v2 also has no runtime `plugins.updater.active` / `dialog` switch. The
plugin's own config struct reads only `pubkey`, `endpoints`,
`dangerousInsecureTransportProtocol`, `dangerousAcceptInvalidCerts`,
`dangerousAcceptInvalidHostnames` and `windows`; `active`/`dialog` were v1-era
keys that this config used to carry, and they were removed rather than flipped
to `true`, because a flag that does nothing is worse than no flag. The plugin is
registered unconditionally and stays inert until JS calls it. So "wired" here
means the feed, the signing and the verification are real — not that users see
update prompts.

## 6. What updates preserve (verified by `test:release`)

User data lives **outside** the install directory (`app_data_dir` on the OS):

- SQLite database (netpulse.db) + WAL — tests, history, events
- VPN profiles & provider credentials
- Settings (incl. schedules, theme, custom resolvers)
- Node database / imported subscriptions
- Daemon token (memory-only, regenerated each run — never on disk)

Upgrade test: seed an old DB → boot the new bundle → all rows intact, migrations
re-run idempotently. Corrupt-update test: truncated DB → quarantined
(`.corrupt-<ts>`), fresh DB recreated, boot succeeds — no crash loop.

## 7. Distribution checklist

- [ ] `npm run release:version` — version stamped everywhere
- [ ] `npm run desktop:package` — full pipeline (build → signature-enforced verify → rebuild signed installer → first-launch bootstrap → `test:release`)

### Missing WebView2 loader — first-launch diagnostics

The installer ships `WebView2Loader.dll` next to the exe via
`webviewInstallMode: embedBootstrapper`, so a normal install has the loader
already in place. If a user still runs the exe without its loader (e.g. copied
only the exe, or AV moved it), the Windows loader refuses to start the process
before any app code runs — there is no way to display a GUI error at that stage.

What the app does instead: on first launch the native side inspects whether the
loader was found, whether the WebView2 run-time is available, and whether the
sidecar backend started; whichever step fails, the app renders a clear
**first-launch diagnostic screen** naming the missing piece and one of:
- `Run WebView2 bootstrapper` (ships the Microsoft bootstrapper that installs the
  Evergreen WebView2 Runtime on the machine, after which the app launches normally),
- `Move the exe back next to its WebView2Loader.dll` (for the mis-copied case),
- `Reinstall from the installer` (authoritative fix), or
- `Start in Safe Mode` (the app still opens — diagnostics and settings remain
  available).

`scripts/post-install-bootstrap.mjs` seeds `bootstrap-status.json` at install
time (idempotent) so the first-launch path knows the install was fresh and can
surface the right buttons. The loader and sidecar bundle are present checks; if
either is missing the app still diagnoses it live. Stub for the bootstrapper
button: invoke the Microsoft WebView2 Evergreen bootstrapper
(`https://aka.ms/WinDevToolsNetCore` / `webview2_bootstrapper.exe` downloaded and
run from app-local temp) — implement only when you have a verified, stable
download URL to ship; never hard-code a credential or an opaque binary run.

The correct recovery for a missing-loader launch is always reinstall via the
installer (or restore the exe next to its DLL).
- [ ] `npm run desktop:verify` — pipeline checks green, including **WebView2Loader.dll bundled**
- [ ] Full test matrix green (section 3)
- [ ] `npm run desktop:build` on Windows (MSVC) / macOS (Xcode) / Linux
- [ ] Sign if credentials available; note unsigned status otherwise
- [ ] Tag `v<version>`, attach installers + `latest.json` (if updater active)
- [ ] Verify installer on a clean machine (no Node required)
- [ ] After install, confirm `WebView2Loader.dll` sits beside the exe (windows-gnu
      builds import it dynamically — a missing DLL means the process cannot
      start at all; see section 8)

## 8. Windows build toolchain notes (real findings)

- **windows-gnu toolchain links WebView2Loader.dll dynamically.** The exe's
  first import table entry is that DLL; if it is not beside the exe, Windows
  shows "The code execution cannot proceed because WebView2Loader.dll was not
  found" and **no window is ever created**. The DLL is vendored at
  `src-tauri/WebView2Loader.dll` and declared in `bundle.resources` so every
  installer always lays it beside the exe. `desktop:verify` fails loudly if it
  goes missing.
- **windres (tauri-winres) cannot handle spaces in the project path.** Build
  from a space-free copy: `robocopy`/`cp -r` the repo to `C:\np-src`, run
  `npx tauri build` there, and copy artifacts back to
  `src-tauri/target/…/release/`.
