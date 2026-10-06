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
issue="$(
  gh api --paginate "repos/{owner}/{repo}/issues?labels=${LABEL}&state=open&per_page=100" \
    --jq '.[] | select(.pull_request | not) | .number' | sort -n | head -n 1
)"

if [ -z "$issue" ]; then
  echo "No open issue labelled '$LABEL' in this repository: no reviews have logged process findings yet." >&2
  exit 3
fi

echo "tracking-issue: $issue"
echo "url: $(gh api "repos/{owner}/{repo}/issues/${issue}" --jq '.html_url')"

log="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${issue}/comments" \
    --jq '.[] | "\n======== comment \(.id) by \(.user.login) at \(.created_at) (updated \(.updated_at)) ========\n\(.body)"'
)"
printf '%s\n' "$log"

# The owner's decisions on each reviewed PR are recorded in the response comment the
# address-pr-review skill posts on that PR.
prs="$(printf '%s\n' "$log" | sed -n 's/^<!-- agent-pr-review:process pr=\([0-9][0-9]*\)\( sha=[0-9a-f]*\)\{0,1\} -->$/\1/p' | sort -un)"

for pr in $prs; do
  state="$(gh api "repos/{owner}/{repo}/pulls/${pr}" --jq 'if .merged_at then "merged" else .state end' 2>/dev/null || echo "unknown")"
  printf '\n======== decisions and fixes on PR #%s (%s) ========\n' "$pr" "$state"
  response="$(
    gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
      --jq '.[] | select(.body | startswith("<!-- agent-pr-review:response")) | "response comment \(.id) by \(.user.login), posted \(.created_at)\n\(.body)\n"'
  )"
  if [ -n "$response" ]; then
    printf '%s\n' "$response"
  else
    echo "No response comment: no fixes or decisions recorded on this PR yet."
  fi

  # What the reviews themselves say about the reviewer: per report, its counts line, and
  # the earlier findings it withdrew (a sign an earlier round was wrong).
  printf '\n======== reviewer signals on PR #%s ========\n' "$pr"
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq '.[] | select(.body | startswith("<!-- agent-pr-review:report")) | .body' |
    awk '
      /^<!-- agent-pr-review:report / { s = $0; sub(/.*sha=/, "", s); sub(/ .*/, "", s); if (s != last) { print "report " substr(s, 1, 7); last = s } }
      /^Confirmed findings after verification: / { print "  " $0 }
      /^By action: / { print "  " $0 }
      /\| *withdrawn *\|/ { print "  withdrawn: " $0 }
    ' || true
done

# Deferrals: findings the owner deferred to an upcoming issue, and that issue's state now.
deferred="$(for pr in $prs; do
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq '.[] | select(.body | startswith("<!-- agent-pr-review:response")) | .body' 2>/dev/null |
    grep -oE '\| *[A-Za-z0-9-]+ *\| *deferred to #[0-9]+' | sed "s/^/#${pr} /" || true
done | sort -u)"
if [ -n "$deferred" ]; then
  printf '\n======== deferrals ========\n'
  printf '%s\n' "$deferred" | while IFS= read -r d; do
    target="$(printf '%s' "$d" | grep -oE 'deferred to #[0-9]+' | grep -oE '[0-9]+')"
    st="$(gh api "repos/{owner}/{repo}/issues/${target}" --jq '.state + (if .state_reason then " (" + .state_reason + ")" else "" end)' 2>/dev/null || echo unknown)"
    echo "$(printf '%s' "$d" | tr -s ' |' ' ') · target is $st"
  done
fi
