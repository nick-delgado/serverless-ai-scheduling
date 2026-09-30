#!/usr/bin/env bash
# Print the latest agent PR review report on a pull request: author, time, URL, then the
# report body.
#
# Usage: get-review.sh <pr-number>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.
# Exits 3 when the PR has no review report.

set -euo pipefail

MARKER='<!-- agent-pr-review:report -->'

if [ "$#" -ne 1 ]; then
  echo "usage: $(basename "$0") <pr-number>" >&2
  exit 2
fi

pr="$1"

case "$pr" in
  '' | *[!0-9]*)
    echo "error: PR number must be numeric, got '$pr'" >&2
    exit 2
    ;;
esac

id="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq ".[] | select(.body | startswith(\"${MARKER}\")) | .id" |
    tail -n 1
)"

if [ -z "$id" ]; then
  echo "No agent PR review report found on PR #${pr}." >&2
  exit 3
fi

echo "report-author: $(gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.user.login')"
echo "gh-account: $(gh api user --jq '.login')"
gh api "repos/{owner}/{repo}/issues/comments/${id}" \
  --jq '"updated: \(.updated_at)\nurl: \(.html_url)\n----\n\(.body)"'
