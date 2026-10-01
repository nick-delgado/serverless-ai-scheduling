#!/usr/bin/env bash
# Print the latest agent PR review report on a pull request, the commit it reviewed, and the
# PR's current head, then the report body.
#
# Usage: get-review.sh <pr-number>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.
# Exits 3 when the PR has no review report.

set -euo pipefail

MARKER='<!-- agent-pr-review:report'

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

body="$(gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.body')"

# The reviewed commit: from the marker, or from the header of reports written before the
# marker carried it.
reviewed="$(printf '%s\n' "$body" | head -n 1 | sed -n 's/^<!-- agent-pr-review:report sha=\([0-9a-f]*\) -->$/\1/p')"
if [ -z "$reviewed" ]; then
  reviewed="$(printf '%s\n' "$body" | sed -nE 's/.*\*\*(Head|Reviewed commit):\*\* \[?`([0-9a-f]+)`.*/\2/p' | head -n 1)"
fi
head_sha="$(gh pr view "$pr" --json headRefOid --jq '.headRefOid')"

echo "report-author: $(gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.user.login')"
echo "gh-account: $(gh api user --jq '.login')"
echo "report-url: $(gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.html_url')"
echo "reviewed-commit: ${reviewed:-unknown}"
echo "pr-head: ${head_sha}"
if [ -z "$reviewed" ]; then
  echo "match: unknown. The report does not name the commit it reviewed."
else
  case "$head_sha" in
    "$reviewed"*) echo "match: yes" ;;
    *) echo "match: NO. The PR has changed since this review." ;;
  esac
fi
echo "----"
printf '%s\n' "$body"
