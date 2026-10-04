#!/usr/bin/env bash
set -euo pipefail

echo "== audit:ci =="
FAILED=0

run() {
  local label="$1"
  shift
  echo ""
  echo "--- $label ---"
  if "$@"; then
    echo "PASS  $label"
  else
    echo "FAIL  $label"
    FAILED=1
  fi
}

# 1. Circular dependencies (madge) across the three source trees
run "madge circular" npx madge --circular --extensions ts,tsx \
  packages/shared/src apps/api/src apps/web/src

# 2. Exported-but-unused / dead public surface (ts-prune) per TS workspace
run "ts-prune shared" npx ts-prune --project packages/shared/tsconfig.json --no-inspect
run "ts-prune api" npx ts-prune --project apps/api/tsconfig.json --no-inspect
run "ts-prune web" npx ts-prune --project apps/web/tsconfig.json --no-inspect

# 3. Unused npm dependencies (JS/TS)
run "depcheck" node scripts/audit-ci-depcheck.mjs

# 3a. IPC surface: the packaged app's own #[tauri::command] handlers, driven
#     through the webview over CDP exactly as the shipped UI drives them. No
#     other gate touches this seam — cargo test exercises the Rust core as
#     functions, and contrast/layout only see pixels — so a refactor can break
#     the commands while every unit test still passes. This covers the log
#     redaction that decides what a user can export, and the allow-lists behind
#     "Open Logs" and every external link.
#     Runs FIRST among the app gates on purpose: it is the only one that checks
#     the EXE is newer than its Rust sources and rebuilds when it is not, so the
#     contrast and layout gates below inherit a binary that actually contains
#     the current code instead of whatever was left on disk.
#     It only ever calls the REFUSING path of the two spawn-capable commands,
#     so it never opens Explorer or a browser on a developer machine. It writes
#     probe lines into the real log to test redaction end to end and strips them
#     again, asserting its own cleanup. Not covered: the allowing half of
#     reveal_path / open_external, and the reparse-point case (needs Developer
#     Mode to create a symlink). Launches its own app; needs no other instance.
# 3z. Stage the sidecar bundle the desktop actually ships, before any app gate
#     runs. `src-tauri/backend/netpulse-backend.js` is what the Tauri bundle
#     copies next to the exe and what the user's app executes — it is built from
#     `apps/api/src` and it is gitignored, so nothing else in this script would
#     ever regenerate it. Without this step an API fix could be committed, pass
#     every gate below, and still be absent from the installed app, which is
#     exactly what happened once. ~1.3 s, so it is never skipped: a gate that
#     silently graded the wrong artifact is worse than no gate.
run "backend bundle: apps/api/src -> src-tauri/backend (the shipped sidecar)" node scripts/prepare-desktop.mjs

run "ipc: redaction + reveal_path/open_external allow-lists, real app over CDP" node scripts/audit-ipc.mjs

# 3b. Text contrast (WCAG AA) in BOTH themes, plus custom-property integrity,
#     measured on the real packaged app over CDP. The light theme shipped
#     unreadable — a too-light --color-faint, tone colours that were not AA on
#     their own tints, and raw palette inks — so this is now a gate: it walks
#     every route in dark and light and fails on any sub-AA text node. It also
#     fails on any var() reference that resolves to nothing, which silently
#     falls back to inherit/initial instead of erroring (a non-existent token
#     name painted in the wrong colour rather than failing). Same app launch,
#     so the second check is nearly free. Builds on first run (cached after).
run "contrast + custom properties: WCAG AA in dark + light" node scripts/audit-contrast.mjs

# 3c. Layout: no route may overflow horizontally, and no text may render under
#     12px, at 1024/1440/1920 in BOTH themes. Nothing else here looks at
#     geometry — /health scrolled the whole document 97px sideways at 1024px
#     because a check row held one unbreakable Windows path and the flex item
#     refused to shrink below its min-content width, and a sideways scroll is
#     easy to miss by eye. 1920 is here because the window is now sized to the
#     monitor's work area, so the widest layout the app can actually show
#     (~2200px on a 2560px display) was previously measured by no gate at all.
#     Deliberate truncation is reported, not failed: more truncation means small
#     text got worse. The rotated-element exclusion keeps the Gauge's
#     -rotate-[225deg] svg from failing every page that shows a score. Type
#     scale is pinned to 1x, since it is a user preference.
#     Launches its own app; needs no other instance running.
run "layout: no overflow, nothing under 12px (1024/1440/1920, dark+light)" node scripts/audit-layout.mjs

# 4. Security regression suite (the audit's fixed-finding tests). A release
#    must fail if any of these regress: parser fail-safety under hostile
#    config (F9 fuzz), capacity-probe rebinding guard (F3), worker ops-gate
#    rate limit (F2), worker CORS preflight allow-list (F5).
run "security: parser fuzz harness" npx vitest run --root apps/api test/nodeParsers.fuzz.test.ts --reporter=basic
run "security: capacity probe rebinding guard" npx vitest run --root apps/api test/selection.test.ts --reporter=basic
run "security: worker ops gate + CORS allow-list" npx vitest run --root cloud/worker test/ops-page.test.ts test/worker.test.ts --reporter=basic

# 5. The whole API suite, in one gate. This replaces hand-picking files: the
#    two apps/api steps above and the honesty test are all strict subsets of it,
#    so a hand-picked list is exactly how a broken path stays invisible — which
#    is how the node-health rates shipped reading "0% loss" on an unprobed node,
#    and how four separate unmeasured-measurement defects went unnoticed in total.
#    Runs unconditionally and costs ~21 s on this machine, so there is no flag
#    that could quietly skip it. Failures print as `FAIL <file> > <test name>`.
#    Determinism note: this suite used to flake under load (see
#    apps/api/test/helpers/waitForSignal.ts — vi.waitFor's own 1000 ms default
#    raced real completion signals, and abandoning an in-flight sweep leaked its
#    timers into later files). It now holds across repeated full runs.
run "api: full suite (every API path)" npx vitest run --root apps/api --reporter=basic
#    The web suite, likewise complete rather than hand-picked. It was not run at
#    all before this, which is how an honesty fix on the node page could ship
#    with no test rendering it anywhere in the repo.
run "web: full suite (rendered components + policies)" npx vitest run --root apps/web --reporter=basic

exit $FAILED
