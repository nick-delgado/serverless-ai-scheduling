#!/usr/bin/env bash
# Post the review report as a new general comment on a PR.
#
# Every review run gets its own comment, so the PR's conversation shows each round in
# order: earlier reports are never edited. The report's first line names the commit it
# reviewed.
#
# Usage: post-report.sh <pr-number> <report-file>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

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

if ! head -n 1 "$report" | grep -qE '^<!-- agent-pr-review:report sha=[0-9a-f]{40} -->$'; then
  echo "error: the first line of the report must be: <!-- agent-pr-review:report sha=<full reviewed commit> -->" >&2
  exit 1
fi

chars="$(LC_ALL=en_US.UTF-8 wc -m < "$report" | tr -d '[:space:]')"
if [ "$chars" -gt "$MAX_CHARS" ]; then
  echo "error: report is $chars characters; GitHub allows $MAX_CHARS per comment." >&2
  echo "Trim it as described in references/report-template.md and retry." >&2
  exit 1
fi

gh api --method POST "repos/{owner}/{repo}/issues/${pr}/comments" \
  -F "body=@${report}" --jq '"created " + .html_url'
