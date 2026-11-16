# NetPulse V3 — Build Environment

| Item | Value |
| --- | --- |
| Source repository | `E:\Code\Project\Vpn_app` |
| Commit | `76133c54bd4c710fc34bb2fd9dd5ed2154e8e05e` |
| Branch | `main` |
| Working tree | Dirty (68 paths changed/untracked; preserved as-is) |
| Release version | 3.0.0 |
| Build time | 2026-11-14 16:07 local |
| OS | Microsoft Windows 11 Pro 10.0.26200 |
| CPU | 12th Gen Intel Core i7-12700 |
| Rust | rustc 1.98.1 (48a229cea 2026-09-01), cargo 1.98.1 |
| Node | v24.18.0 |
| npm | 12.0.2 |
| Target | `x86_64-pc-windows-msvc` |
| Bundle | NSIS, per-user, WebView2 bootstrapper embedded |
| `package-lock.json` SHA-256 (first 16) | `1fb4240c8abf4c42…` |
| `Cargo.lock` SHA-256 (first 16) | `c6cde96dd0176996…` |

## Version locations synchronized to 3.0.0

- `package.json`
- `apps/api/package.json`
- `apps/web/package.json`
- `packages/shared/package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

`scripts/release.mjs` was corrected to accept CRLF when rewriting the Cargo manifest; before the fix it silently skipped `Cargo.toml`.

## Build commands

```bash
node scripts/release.mjs 3.0.0
npm run desktop:build     # includes frontend build, API desktop bundle, backend staging, tauri build
npm run desktop:verify
```

## Outputs

- `src-tauri/target/release/netpulse-desktop.exe`
- `src-tauri/target/release/bundle/nsis/NetPulse_3.0.0_x64-setup.exe`
- Packaged copies under `E:\Code\Project\releases\NetPulse-V3.0.0`

The installer is unsigned. No signing identity was available; no signature was fabricated.
