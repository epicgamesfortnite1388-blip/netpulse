#!/usr/bin/env bash
# Surface a reconciler-verifier regression without anyone watching the Actions tab.
#
# The two host reconciler verifiers (`scripts/verify-vps-reconciler-removal.py`
# and `scripts/verify-vps-reconciler-failure.py`) prove that a revoked or
# expired identity disappears from the server config, and that a Worker outage
# cannot wipe or resurrect one. They run on a schedule because the failure they
# guard against is silent: the reconciler keeps working, just on stale input.
#
# A red check on a scheduled run is not an alert — nobody is looking. This
# script turns the run result into state that persists until someone acts:
#
#   failed  -> open (or comment on) a GitHub issue labelled `reconciler-regression`
#   success -> comment the recovery and close that issue
#
# It also POSTs a short message to `OPS_ALERT_WEBHOOK_URL` when that secret is
# configured, so the owner can be reached on a phone. The webhook is optional on
# purpose: the issue is the durable record, and a site without the secret still
# gets a real alert rather than a skipped step.
#
# Every gh call names `--repo` explicitly: a scheduled run's checkout can be
# detached, and gh would otherwise have to infer the repository.
#
# Inputs (all from the workflow):
#   REPO      owner/name
#   RESULT    needs.<job>.result — success | failure | cancelled | skipped
#   RUN_URL   link to the run
#   EVENT     github.event_name (for the issue text)
#   WEBHOOK   optional secret; empty means "no push notification"
#
# Exit status is 0 once the alert state is recorded, even for a failed verifier
# — the verifier job is what must go red. A failure of the alerting itself exits
# non-zero so a broken alert path cannot masquerade as "nothing to report".

set -euo pipefail

REPO="${REPO:?REPO is required}"
RESULT="${RESULT:-unknown}"
RUN_URL="${RUN_URL:-}"
EVENT="${EVENT:-unknown}"
WEBHOOK="${WEBHOOK:-}"

LABEL="reconciler-regression"
TITLE="Reconciler verifier regression (entitlement removal / failure handling)"

if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "alert: no GH_TOKEN/GITHUB_TOKEN in the environment" >&2
  exit 2
fi

open_issue() {
  gh issue list --repo "$REPO" --label "$LABEL" --state open --json number --jq '.[0].number // empty'
}

ensure_label() {
  gh label create "$LABEL" --repo "$REPO" \
    --color B60205 \
    --description "A scheduled reconciler verifier failed" \
    --force >/dev/null
}

body_for_failure() {
  cat <<EOF
The scheduled host-reconciler verifiers failed.

- **Result:** \`${RESULT}\`
- **Trigger:** \`${EVENT}\`
- **Run:** ${RUN_URL}

What is guarded:

- \`scripts/verify-vps-reconciler-removal.py\` — a rotated secret, a revoked
  identity and an expired identity must not survive the next reconciler pass,
  and an unchanged set must not churn the config.
- \`scripts/verify-vps-reconciler-failure.py\` — a failed pull keeps the last
  known-good set, a malformed payload applies nothing, an empty set applies
  deny-all, expiry is still enforced while the Worker is down, and an invalid
  \`xray\` binary fails closed.

This issue stays open until a run passes, at which point it is commented and
closed automatically. Do not close it by hand to silence the alert.
EOF
}

body_for_recovery() {
  cat <<EOF
Recovered: the scheduled reconciler verifiers passed again.

- **Run:** ${RUN_URL}

Closing automatically. Reopen by re-running the workflow if this was a flake.
EOF
}

# A cancelled or skipped run proved nothing — concurrency cancels a superseded
# run routinely, and opening a regression issue for it would train the owner to
# ignore the label. Only a real pass may close an alert, and only a real failure
# may open one.
if [ "$RESULT" = "cancelled" ] || [ "$RESULT" = "skipped" ]; then
  echo "alert: verifiers did not run (${RESULT}); alert state left untouched"
  exit 0
fi

ensure_label
existing="$(open_issue)"

if [ "$RESULT" = "success" ]; then
  if [ -n "$existing" ]; then
    gh issue comment "$existing" --repo "$REPO" --body "$(body_for_recovery)" >/dev/null
    gh issue close "$existing" --repo "$REPO" --reason completed >/dev/null
    echo "alert: recovery recorded on issue #$existing"
  else
    echo "alert: verifiers passed and no regression issue is open"
  fi
  exit 0
fi

body="$(body_for_failure)"
if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$REPO" --body "$body" >/dev/null
  echo "alert: commented on open issue #$existing"
else
  url="$(gh issue create --repo "$REPO" --title "$TITLE" --body "$body" --label "$LABEL")"
  echo "alert: opened $url"
fi

if [ -n "$WEBHOOK" ]; then
  payload="$(python3 - "$TITLE" "$RUN_URL" "$RESULT" <<'PY'
import json, sys
title, run_url, result = sys.argv[1:4]
print(json.dumps({"text": f"{title}: {result}. {run_url}"}))
PY
)"
  # `--fail` so a rejected webhook is visible in the job log, but the issue above
  # is already the durable alert — do not re-fail the workflow over transport.
  curl -sS --fail -X POST -H 'content-type: application/json' \
    --data "$payload" "$WEBHOOK" >/dev/null || echo "alert: webhook delivery failed" >&2
fi
