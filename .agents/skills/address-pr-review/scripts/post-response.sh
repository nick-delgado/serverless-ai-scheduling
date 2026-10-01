#!/usr/bin/env bash
# Post the response to an agent PR review as a new comment on the PR.
#
# Every run of the address-pr-review skill gets its own comment, so the PR's conversation
# shows each round in order: earlier responses are never edited. The response's first line
# names the reviewed commit and the commit the fixes produced.
#
# Usage: post-response.sh <pr-number> <response-file>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

MAX_CHARS=65536

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <pr-number> <response-file>" >&2
  exit 2
fi

pr="$1"
file="$2"

case "$pr" in
  '' | *[!0-9]*)
    echo "error: PR number must be numeric, got '$pr'" >&2
    exit 2
    ;;
esac

if [ ! -s "$file" ]; then
  echo "error: response file '$file' is missing or empty" >&2
  exit 1
fi

if ! head -n 1 "$file" | grep -qE '^<!-- agent-pr-review:response review=[0-9a-f]{40} head=[0-9a-f]{40} -->$'; then
  echo "error: the first line of the response must be: <!-- agent-pr-review:response review=<full reviewed commit> head=<full commit after the fixes> -->" >&2
  exit 1
fi

chars="$(LC_ALL=en_US.UTF-8 wc -m < "$file" | tr -d '[:space:]')"
if [ "$chars" -gt "$MAX_CHARS" ]; then
  echo "error: response is $chars characters; GitHub allows $MAX_CHARS per comment." >&2
  exit 1
fi

gh api --method POST "repos/{owner}/{repo}/issues/${pr}/comments" \
  -F "body=@${file}" --jq '"created " + .html_url'
