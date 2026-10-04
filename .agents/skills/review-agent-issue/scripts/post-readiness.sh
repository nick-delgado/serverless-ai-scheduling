#!/usr/bin/env bash
# Post a readiness review, or the record of an apply step, as a new comment on an issue.
#
# Usage: post-readiness.sh <issue-number> <file>
#
# The file's first line must be
#   <!-- agent-pr-review:readiness round=<k> -->           (a readiness review), or
#   <!-- agent-pr-review:readiness-applied round=<k> -->   (what the apply step changed)
# Earlier comments are never edited. Uses the REST API only.

set -euo pipefail

MAX_CHARS=65536

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <issue-number> <file>" >&2
  exit 2
fi

n="$1"
file="$2"
case "$n" in '' | *[!0-9]*) echo "error: issue number must be numeric, got '$n'" >&2; exit 2 ;; esac
[ -s "$file" ] || { echo "error: '$file' is missing or empty" >&2; exit 1; }

if ! head -n 1 "$file" | grep -qE '^<!-- agent-pr-review:readiness(-applied)? round=[0-9]+ -->$'; then
  echo "error: the first line must be <!-- agent-pr-review:readiness round=<k> --> or <!-- agent-pr-review:readiness-applied round=<k> -->" >&2
  exit 1
fi

chars="$(LC_ALL=en_US.UTF-8 wc -m < "$file" | tr -d '[:space:]')"
if [ "$chars" -gt "$MAX_CHARS" ]; then
  echo "error: $file is $chars characters; GitHub allows $MAX_CHARS per comment. A readiness review that long is asking too much: cut it to the questions that matter." >&2
  exit 1
fi

gh api --method POST "repos/{owner}/{repo}/issues/${n}/comments" -F "body=@${file}" --jq '"created " + .html_url'
