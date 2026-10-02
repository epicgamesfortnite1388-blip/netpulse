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

exit $FAILED
