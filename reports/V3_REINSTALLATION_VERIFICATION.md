# NetPulse V3 — Reinstallation Verification

## Before installation

| Item | Value |
| --- | --- |
| Previously installed version | 1.5.1 |
| Install location | `C:\Users\RADIN\AppData\Local\NetPulse` |
| Uninstaller | `C:\Users\RADIN\AppData\Local\NetPulse\uninstall.exe` |
| Data directory | `C:\Users\RADIN\AppData\Roaming\app.netpulse.desktop` |
| WebView data | `C:\Users\RADIN\AppData\Local\app.netpulse.desktop` |
| Running processes before install | None |
| Database | 339,578,880 bytes |
| Backup location | `E:\Code\Project\backups\NetPulse-pre-V3-20261114-160428` |

## Backup

The backup was created with `robocopy /E` before installation and was verified:

- 717 files, 338.86 MiB copied, 0 failed.
- `netpulse.db` SHA-256: `fae50add5feb256af648d45f6bbc1cce895be214ee292d1bb7c1027ca910e744` — identical to the live file.
- `settings-marker.json` SHA-256: `cff08e28a1c91377015c4c0ee43ede775e93483e4b3870dd8e96b0bcb3f511e4` — identical to the live file.
- Both AppData directories were copied; no user data was deleted.

The backup is outside the installer/release package. It contains personal data and secrets and must not be redistributed.

## Installation

Command:

```
NetPulse_3.0.0_x64-setup.exe /S
```

Result: exit 0. The installer performed a per-user upgrade. The previous application was not manually uninstalled and its data directory was not touched.

Post-install state:

| Item | Value |
| --- | --- |
| Registry DisplayVersion | 3.0.0 |
| Install location | `C:\Users\RADIN\AppData\Local\NetPulse` |
| Executable | `C:\Users\RADIN\AppData\Local\NetPulse\netpulse-desktop.exe` |
| Executable FileVersion / ProductVersion | 3.0.0 / 3.0.0 |
| CompanyName | NetPulse |
| WebView2Loader.dll present beside executable | Yes |
| Backend directory present | Yes |

## Launch verification

The installed executable was started directly from the install location.

- Process: `netpulse-desktop`, window title `NetPulse`, `Responding: True`, non-zero main window handle.
- Log: `=== NetPulse desktop starting (v3.0.0) ===`, executable path is the installed path.
- Log: `sidecar-ready port=47615`; `bootstrap: sidecar answered after 2333 ms`.
- HTTP `GET http://127.0.0.1:47615/api/v1/health` returned **401** without a bearer token, confirming the sidecar is running and enforcing authentication.

## Data preservation

| Item | Result |
| --- | --- |
| Database size and mtime | Unchanged (2026-11-13 21:14, 339,578,880 bytes) |
| `settings-marker.json` hash | Unchanged |
| VPN profile directories | 18 present |
| Secret-store entries | Preserved (49717 files in `secrets/`) |
| Migration errors in log | None found |

## Shutdown

The product intentionally uses close-to-tray: `CloseMainWindow` hides the window instead of exiting. The tray "Quit" action is the documented exit path. Tray-menu automation was not available in this environment, so the process was left running rather than force-killed. This is a **PARTIAL** verification of shutdown, not a failure.

## Status

Installation: **PASS**.
Data preservation: **PASS**.
Launch: **PASS**.
Version correctness: **PASS**.
Graceful full exit: **NOT FULLY TESTED** (close-to-tray confirmed; tray Quit not automated).
