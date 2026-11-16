# NetPulse V3 — Post-Installation Tests

Tests were performed against the **installed** application at
`C:\Users\RADIN\AppData\Local\NetPulse\netpulse-desktop.exe` (version 3.0.0), not against a development build.

| Workflow | Status | Evidence / reason |
| --- | --- | --- |
| Fresh launch | PASS | Process running, main window `NetPulse`, responding |
| Application version | PASS | FileVersion/ProductVersion 3.0.0; log `starting (v3.0.0)` |
| Rust backend initialization | PASS | Log: window created, sized, shown, loaded `http://tauri.localhost/` |
| Sidecar initialization | PASS | Log: config/db/schedulers/routes ok, `sidecar-ready port=47615` |
| Local storage opens | PASS | Log `boot stage=db:ok` against the existing 340 MB database |
| Settings load | PARTIAL | Settings marker preserved byte-identically; UI values not clicked through |
| Network diagnostics (UI) | NOT TESTED | Not exercised in the installed UI |
| NANI observation/diagnosis | NOT TESTED | Not exercised in the installed UI |
| NANI safe recovery | NOT TESTED | Deliberately not run against the user's live network |
| Configuration gatherer (live sources) | NOT TESTED | No third-party retrieval performed |
| Cloud sign-in / entitlement | NOT TESTED | No credentials entered |
| Telegram linking | NOT TESTED | Requires account interaction |
| Local AI disabled | PASS | Copilot is cloud-proxied; with no AI backend it returns an honest 503-style error, no fake answer |
| Offline backend behavior | NOT TESTED | Not simulated on the installed build |
| Second launch / single instance | PASS | Second launch did not create a second process; existing window remained |
| Restart | PASS | App was launched again after close-to-tray and answered on the sidecar |
| Normal shutdown | PARTIAL | Close-to-tray hides the window by design; tray Quit not automated |
| Unauthenticated API access | PASS | HTTP 401 from installed sidecar |

## Not performed, and why

The user's live network was not disrupted; no proxy, DNS or routing settings were changed. No system-wide configuration was modified. Clicking through NANI and the configuration gatherer in the installed window would require interactive UI automation that this run did not perform.

These workflows are **not claimed as passing**.
