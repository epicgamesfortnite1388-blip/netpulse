# NetPulse V3 — Artifact Inspection

## Artifacts

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `NetPulse-V3.0.0-setup.exe` | 36 MB | `4f35bf569651adfc1329def2ac55338efe33c4e627db1175b9f3ac6d9d23862f` |
| `application/netpulse-desktop.exe` | 6.6 MB | `d8749372a0971cfb188f704be33cd016713fe08e69571c1a36ac9a793641eb43` |
| `application/WebView2Loader.dll` | 157 KB | `8427b1fc58ec707813e5c0a51eb5d69397bb333250a7b891be4d3b123f1e0f1c` |

## Metadata

| Property | Executable | Installer |
| --- | --- | --- |
| ProductName | NetPulse | NetPulse |
| FileVersion | 3.0.0 | 3.0.0 |
| ProductVersion | 3.0.0 | 3.0.0 |
| CompanyName | NetPulse | *(blank)* |
| Architecture | x86_64 | x86_64 |

The blank installer CompanyName is a metadata gap, not a functional defect: Tauri's `publisher` is set to `NetPulse`, but the NSIS version resource does not carry it.

## Contents

- Installer: Tauri NSIS package with the application, bundled portable Node runtime, backend bundle, Drizzle migrations and WebView2 bootstrapper.
- Application directory: executable, `WebView2Loader.dll`, and the full `backend/` staging needed to run beside the executable.
- No `.env`, `.pem`, `.key`, database, user configuration, source map or development dependency is included.
- No updater artifact was generated (`createUpdaterArtifacts: false`).

## Signature

**Unsigned.** No Authenticode certificate was available. `Get-AuthenticodeSignature` was not run because there is no signature to validate. Windows SmartScreen will show an "unknown publisher" warning. Integrity must be checked with the published SHA-256 values.

## Installation hash note

The installed `C:\Users\RADIN\AppData\Local\NetPulse\netpulse-desktop.exe` has SHA-256 `05d5fd15eef9775056eed8e63ae96f6982cf73c127619c8e222e7dbc79df2921`, which differs from the staged release executable. NSIS installs its own packed payload and rewrites the PE resource section; the installed file reports 3.0.0 and runs. The release hash above must be used to verify the *published* executable, not the installed copy.
