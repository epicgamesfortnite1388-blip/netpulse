# FINAL_UI_RECOVERY_08_VISUAL_VERIFICATION

## Evidence set

Final screenshots:

```text
reports/FINAL_UI_visual_recovery/v2-01-dashboard-connection-hero.png
reports/FINAL_UI_visual_recovery/v2-02-settings-general.png
reports/FINAL_UI_visual_recovery/v2-03-settings-network.png
reports/FINAL_UI_visual_recovery/v2-04-settings-platform.png
reports/FINAL_UI_visual_recovery/v2-05-copilot-empty.png
reports/FINAL_UI_visual_recovery/v2-06-nani.png
reports/FINAL_UI_visual_recovery/v2-07-dashboard-narrow.png
reports/FINAL_UI_visual_recovery/v2-08-copilot-light.png
```

Manifest: `reports/FINAL_UI_visual_recovery/v2-manifest.json`.

Viewports covered: 1440×900, 1280×720, 800×900. Themes covered: dark and light.

## Sequence and evidence integrity

1. First capture set (`rec-*.png`) was invalid: the isolated Vite config lacked `@shared`, `@netpulse/shared`, and `@cloud-contract` aliases, producing an error overlay.
2. Aliases were mirrored from the shipped `vite.config.ts`.
3. Recaptured set (`v2-*.png`) showed real hydration and no overlay.
4. Mounting `ConnectionHero` exposed a real runtime crash: `TypeError: Cannot read properties of undefined (reading 'state')` in `connectionState.ts`.
5. Optional chaining was added, regression guard added, and screenshots were recaptured as the final `v2-*` set.

## Verified observations

| Check | Result |
|---|---|
| Dashboard renders with h1 “Dashboard” | PASS |
| Connection console route renders without crash (source + dashboard screenshot) | PASS — final screenshot shows `Awaiting data / No measurements yet` because no backend data was available |
| No horizontal overflow (`scrollW == clientW`) at 1440, 1280, and 800 px | PASS |
| Settings tab deep links render without crash | PASS |
| Copilot empty state shows exactly one prompt (F-36) | PASS |
| Copilot availability badge says `Unavailable here` when no model status exists (F-31) | PASS |
| Light theme Copilot readable | PASS |
| NANI page renders | PASS |

## Honest limitations

- No API sidecar was running. Settings remains in `Loading settings...`; this is an honest backend-unavailable state, not a data-backed settings verification.
- Therefore C6’s “data-backed visual pass with API sidecar” remains incomplete.
- No claim is made that live connection, VPN, or backend-driven values were visually validated.

## Conclusion

Visual recovery is **PASS for structural/behavioral UI scope** and **PARTIAL for data-backed scope**.
