#!/usr/bin/env bash
# Print the agent process tracking issue and every comment on it, oldest first.
#
# Usage: get-process-log.sh
# Run from inside a clone of the repository. Requires an authenticated gh.
# Exits 3 when the repository has no tracking issue.

set -euo pipefail

LABEL='agent-process'

if [ "$#" -ne 0 ]; then
  echo "usage: $(basename "$0")" >&2
  exit 2
fi

# The tracking issue is the oldest open issue carrying the label.
issue="$(gh issue list --label "$LABEL" --state open --limit 100 --json number --jq 'map(.number) | min // empty')"

if [ -z "$issue" ]; then
  echo "No open issue labelled '$LABEL' in this repository: no reviews have logged process findings yet." >&2
  exit 3
fi

echo "tracking-issue: $issue"
echo "url: $(gh issue view "$issue" --json url --jq '.url')"

gh api --paginate "repos/{owner}/{repo}/issues/${issue}/comments" \
  --jq '.[] | "\n======== comment \(.id) by \(.user.login) at \(.created_at) (updated \(.updated_at)) ========\n\(.body)"'
