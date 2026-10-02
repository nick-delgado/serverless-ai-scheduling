#!/usr/bin/env bash
# Print the latest agent PR review report on a pull request, the commit it reviewed, and the
# PR's current head, then the report body. A report posted in several comments (parts) is
# printed whole, its parts joined in order.
#
# Usage: get-review.sh <pr-number>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.
# Exits 3 when the PR has no review report.

set -euo pipefail

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

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The latest report, with its parts joined if it was posted in several comments.
latest="$("$here/get-reports.sh" "$pr" "$tmp" | tail -n 1)"
if [ -z "$latest" ]; then
  echo "No agent PR review report found on PR #${pr}." >&2
  exit 3
fi
IFS="$(printf '\t')" read -r file reviewed parts url posted <<< "$latest"
body="$(cat "$file")"
head_sha="$(gh api "repos/{owner}/{repo}/pulls/${pr}" --jq '.head.sha')"
author="$(gh api "repos/{owner}/{repo}/issues/comments/${url##*-}" --jq '.user.login')"

echo "report-author: ${author}"
echo "gh-account: $(gh api user --jq '.login')"
echo "report-url: ${url}"
echo "report-parts: ${parts}"
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
