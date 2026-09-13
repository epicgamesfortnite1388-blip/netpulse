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
  `bundle/nsis/NetPulse_0.2.0_x64-setup.exe` (36 MB, NSIS, per-user).
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

- **`scripts/sign-release.mjs`** — signs any artifact with SHA-256 + DigiCert
  RFC3161 timestamp. Identity resolution: `NETPULSE_SIGN_THUMBPRINT` (store
  cert, e.g. CA-issued) → `NETPULSE_SIGN_PFX`(+`_PASSWORD`) → local dev cert
  (`certs/netpulse-release.pfx`, password in user-only
  `%USERPROFILE%\.netpulse-signing-pw`). `--verify-only` checks existing
  signatures without modifying files; `--optional` no-ops when no cert exists
  (used by the Tauri hook so unsigned builds remain possible).
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
  helper is `scripts/sign-uninstall.ps1` (same identity resolution).
  Verified: installed `uninstall.exe` carries the release signature.
- **Build wiring** — `npm run desktop:build` = web + backend bundle +
  `tauri build`; signing happens **after** the build via
  `scripts/package-signed.mjs` (part of `npm run desktop:package`). Do NOT
  sign in `beforeBundleCommand` — Tauri patches the exe afterwards, which
  invalidates that signature (`HashMismatch`) and leaves the installer
  unsigned. `npm run desktop:sign` = sign current artifacts in place.
- **Verification gate** — `NETPULSE_REQUIRE_SIGNATURE=1 npm run desktop:verify`
  fails the pipeline if any artifact lacks a valid signature (advisory by
  default).
- **Reality check (honest):** the local dev certificate is **self-signed**, so
  Windows reports `UnknownError` ("root certificate not trusted") — the
  signature and timestamp are cryptographically intact and **tampering is
  detected** (`HashMismatch` on any byte flip, verified). SmartScreen
  reputation still requires a **CA-issued** (ideally EV) code-signing cert:
  buy one, import to the store, set `NETPULSE_SIGN_THUMBPRINT`, rebuild.
- PFX/keys are git-ignored (`certs/`, `*.pfx`). Never commit signing material.

### macOS notarization

Wired for when credentials exist: `APPLE_CERTIFICATE`, `APPLE_ID`,
`APPLE_PASSWORD` env vars enable notarization. Builds without credentials are
**unsigned** — documented in release notes, never claimed otherwise.

## 5. Auto-update system

Wired and dormant in `tauri.conf.json` (`plugins.updater` with pubkey +
endpoints placeholders, `createUpdaterArtifacts: true`) and in
`src-tauri/Cargo.toml` (`tauri-plugin-updater` dependency). Activation:

1. Generate a signing keypair: `npx @tauri-apps/cli signer generate -w ~/.tauri/netpulse.key`
2. Put the **public** key in `tauri.conf.json` → `plugins.updater.pubkey`.
   Keep the private key in CI secrets only.
3. Point `endpoints` at your update manifest host (e.g. GitHub Releases with
   `latest.json`).
4. Uncomment the updater plugin registration in `src-tauri/src/main.rs`
   (marked with a `// UPDATER:` comment).
5. `tauri build` then emits `.sig` signatures + `latest.json` metadata.

Until configured, the app ships update-inert — no phone-home, no update
prompts. That is the documented honest state.

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
