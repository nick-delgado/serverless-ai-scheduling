#!/usr/bin/env bash
# Snapshot an issue's description and collect its earlier readiness reviews.
#
# Usage: get-readiness.sh <issue-number> <run-dir>
#
# Writes into <run-dir>:
#   issue-body.md            the issue's description exactly as it is now (the apply step
#                            refuses to overwrite a description that changed after this)
#   previous/round-<k>.md    each earlier readiness review, by round
#   previous/applied-<k>.md  each earlier "applied" comment, by round
# Prints:
#   latest-round: <k, or 0 when the issue has no readiness review>
#   next-round: <k + 1>
#   latest-review-url: <URL, when there is one>
# Uses the REST API only. Run from inside a clone of the repository.

set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -d "$2" ]; then
  echo "usage: $(basename "$0") <issue-number> <run-dir>" >&2
  exit 2
fi

n="$1"
run="$2"
case "$n" in '' | *[!0-9]*) echo "error: issue number must be numeric, got '$n'" >&2; exit 2 ;; esac

gh api "repos/{owner}/{repo}/issues/${n}" --jq '.body // ""' > "$run/issue-body.md"
mkdir -p "$run/previous"

latest=0
latest_url=""
while IFS="$(printf '\t')" read -r id url first; do
  [ -n "$id" ] || continue
  round="$(printf '%s' "$first" | sed -n 's/.*round=\([0-9][0-9]*\).*/\1/p')"
  [ -n "$round" ] || continue
  case "$first" in
    "<!-- agent-pr-review:readiness-applied"*) kind="applied" ;;
    *) kind="round" ;;
  esac
  gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.body' > "$run/previous/${kind}-${round}.md"
  if [ "$kind" = "round" ] && [ "$round" -ge "$latest" ]; then
    latest="$round"
    latest_url="$url"
  fi
done < <(
  gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" \
    --jq '.[] | select(.body | startswith("<!-- agent-pr-review:readiness")) | "\(.id)\t\(.html_url)\t\(.body | split("\n")[0])"'
)

echo "latest-round: $latest"
echo "next-round: $((latest + 1))"
[ -z "$latest_url" ] || echo "latest-review-url: $latest_url"
