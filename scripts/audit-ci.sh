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

# 4. Security regression suite (the audit's fixed-finding tests). A release
#    must fail if any of these regress: parser fail-safety under hostile
#    config (F9 fuzz), capacity-probe rebinding guard (F3), worker ops-gate
#    rate limit (F2), worker CORS preflight allow-list (F5).
run "security: parser fuzz harness" npx vitest run --root apps/api test/nodeParsers.fuzz.test.ts --reporter=basic
run "security: capacity probe rebinding guard" npx vitest run --root apps/api test/selection.test.ts --reporter=basic
run "security: worker ops gate + CORS allow-list" npx vitest run --root cloud/worker test/ops-page.test.ts test/worker.test.ts --reporter=basic

exit $FAILED
