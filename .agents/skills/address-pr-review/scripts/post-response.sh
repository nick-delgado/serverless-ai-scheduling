#!/usr/bin/env bash
# Post the response to an agent PR review as a single comment on the PR.
# If this user already posted a response on the PR, that comment is updated instead.
#
# Usage: post-response.sh <pr-number> <response-file>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

MARKER='<!-- agent-pr-review:response -->'
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

if [ "$(head -n 1 "$file")" != "$MARKER" ]; then
  echo "error: the first line of the response must be: $MARKER" >&2
  exit 1
fi

chars="$(LC_ALL=en_US.UTF-8 wc -m < "$file" | tr -d '[:space:]')"
if [ "$chars" -gt "$MAX_CHARS" ]; then
  echo "error: response is $chars characters; GitHub allows $MAX_CHARS per comment." >&2
  exit 1
fi

login="$(gh api user --jq '.login')"

existing="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq ".[] | select(.user.login == \"${login}\") | select(.body | startswith(\"${MARKER}\")) | .id" |
    tail -n 1
)"

if [ -n "$existing" ]; then
  gh api --method PATCH "repos/{owner}/{repo}/issues/comments/${existing}" \
    -F "body=@${file}" --jq '"updated " + .html_url'
else
  gh api --method POST "repos/{owner}/{repo}/issues/${pr}/comments" \
    -F "body=@${file}" --jq '"created " + .html_url'
fi
