#!/usr/bin/env bash
# Record on an upcoming issue that the owner deferred a review finding to it, so the
# issue's readiness review and its coding agent see the work that now belongs to it.
#
# Usage: post-deferral.sh <issue-number> <note-file>
#
# The note's first line must be
#   <!-- agent-pr-review:deferred pr=<n> review=<commit> finding=<ID> -->
# and the same finding is never noted twice on one issue. The issue must be open.
# Uses the REST API only. Run from inside a clone of the repository.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <issue-number> <note-file>" >&2
  exit 2
fi

n="$1"
file="$2"
case "$n" in '' | *[!0-9]*) echo "error: issue number must be numeric, got '$n'" >&2; exit 2 ;; esac
[ -s "$file" ] || { echo "error: '$file' is missing or empty" >&2; exit 1; }

first="$(head -n 1 "$file")"
if ! printf '%s\n' "$first" | grep -qE '^<!-- agent-pr-review:deferred pr=[0-9]+ review=[0-9a-f]{7,40} finding=[A-Za-z0-9-]+ -->$'; then
  echo "error: the first line must be <!-- agent-pr-review:deferred pr=<n> review=<commit> finding=<ID> -->" >&2
  exit 1
fi

state="$(gh api "repos/{owner}/{repo}/issues/${n}" --jq 'if .pull_request then "pull request" else .state end')"
if [ "$state" != "open" ]; then
  echo "error: #${n} is ${state}, not an open issue; ask the owner where the finding should go instead" >&2
  exit 1
fi

if gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" --jq '.[].body | split("\n")[0]' | grep -qxF "$first"; then
  echo "already noted on #${n}"
  exit 0
fi

gh api --method POST "repos/{owner}/{repo}/issues/${n}/comments" -F "body=@${file}" --jq '"created " + .html_url'
