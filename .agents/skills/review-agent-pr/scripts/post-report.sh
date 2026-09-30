#!/usr/bin/env bash
# Post the review report as a single general comment on a PR.
# If this user already posted a report on the PR, that comment is updated instead.
#
# Usage: post-report.sh <pr-number> <report-file>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

MARKER='<!-- agent-pr-review:report -->'
MAX_CHARS=65536

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <pr-number> <report-file>" >&2
  exit 2
fi

pr="$1"
report="$2"

case "$pr" in
  '' | *[!0-9]*)
    echo "error: PR number must be numeric, got '$pr'" >&2
    exit 2
    ;;
esac

if [ ! -s "$report" ]; then
  echo "error: report file '$report' is missing or empty" >&2
  exit 1
fi

if [ "$(head -n 1 "$report")" != "$MARKER" ]; then
  echo "error: the first line of the report must be: $MARKER" >&2
  exit 1
fi

chars="$(LC_ALL=en_US.UTF-8 wc -m < "$report" | tr -d '[:space:]')"
if [ "$chars" -gt "$MAX_CHARS" ]; then
  echo "error: report is $chars characters; GitHub allows $MAX_CHARS per comment." >&2
  echo "Trim it as described in references/report-template.md and retry." >&2
  exit 1
fi

login="$(gh api user --jq '.login')"

# Newest existing report comment by this user, if any.
existing="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq ".[] | select(.user.login == \"${login}\") | select(.body | startswith(\"${MARKER}\")) | .id" |
    tail -n 1
)"

if [ -n "$existing" ]; then
  gh api --method PATCH "repos/{owner}/{repo}/issues/comments/${existing}" \
    -F "body=@${report}" --jq '"updated " + .html_url'
else
  gh api --method POST "repos/{owner}/{repo}/issues/${pr}/comments" \
    -F "body=@${report}" --jq '"created " + .html_url'
fi
