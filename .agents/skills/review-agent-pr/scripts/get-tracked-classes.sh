#!/usr/bin/env bash
# Print the project's tracked failure classes: the "Tracked failure classes" section of the
# latest batch record on the agent-process tracking issue. Prints "none" when there is no
# tracking issue, no batch record, or no such section; the review then uses the harness's
# default list (references/failure-classes.md).
#
# Usage: get-tracked-classes.sh
# Run from inside a clone of the repository. Uses the REST API only.

set -euo pipefail

issue="$(
  gh api --paginate "repos/{owner}/{repo}/issues?labels=agent-process&state=open&per_page=100" \
    --jq '.[] | select(.pull_request | not) | .number' 2>/dev/null | sort -n | head -n 1
)"
if [ -z "$issue" ]; then
  echo "none"
  exit 0
fi

body="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${issue}/comments" \
    --jq '.[] | select(.body | startswith("<!-- agent-pr-review:process-batch -->")) | .id' |
    tail -n 1 |
    { read -r id || true; [ -n "${id:-}" ] && gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.body'; }
)"

section="$(printf '%s\n' "$body" | awk '
  /^#+ Tracked failure classes/ { on = 1; next }
  on && /^#+ / { exit }
  on { print }
' | awk 'NF { seen = 1 } seen')"

if [ -n "$section" ]; then
  printf '%s\n' "$section"
else
  echo "none"
fi
