#!/usr/bin/env bash
# Post a review report as new general comments on a PR: one comment per part, in order.
#
# Every review run gets its own comments, so the PR's conversation shows each round in
# order: earlier reports are never edited. A report too long for one comment comes in parts
# (report-01.md, report-02.md, ...), each starting with
#   <!-- agent-pr-review:report sha=<reviewed commit> run=<run id> part=<k>/<n> -->
#
# Usage: post-report.sh <pr-number> <part-file>...
#   e.g. post-report.sh 70 "$RUN_DIR"/report-[0-9][0-9].md
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

MAX_CHARS=65536

if [ "$#" -lt 2 ]; then
  echo "usage: $(basename "$0") <pr-number> <part-file>..." >&2
  exit 2
fi

pr="$1"
shift

case "$pr" in
  '' | *[!0-9]*)
    echo "error: PR number must be numeric, got '$pr'" >&2
    exit 2
    ;;
esac

# Check every part before posting any, so a bad set posts nothing.
run_key=""
expected=1
total=""
for file in "$@"; do
  if [ ! -s "$file" ]; then
    echo "error: report part '$file' is missing or empty" >&2
    exit 1
  fi
  marker="$(head -n 1 "$file")"
  if ! printf '%s\n' "$marker" | grep -qE '^<!-- agent-pr-review:report sha=[0-9a-f]{40} run=[0-9A-Za-z]+ part=[0-9]+/[0-9]+ -->$'; then
    echo "error: the first line of $file must be: <!-- agent-pr-review:report sha=<full reviewed commit> run=<run id> part=<k>/<n> -->" >&2
    exit 1
  fi
  key="$(printf '%s' "$marker" | sed -E 's/.* (sha=[0-9a-f]+ run=[0-9A-Za-z]+) .*/\1/')"
  part="$(printf '%s' "$marker" | sed -E 's/.*part=([0-9]+)\/([0-9]+).*/\1/')"
  of="$(printf '%s' "$marker" | sed -E 's/.*part=([0-9]+)\/([0-9]+).*/\2/')"
  [ -n "$run_key" ] || { run_key="$key"; total="$of"; }
  if [ "$key" != "$run_key" ] || [ "$of" != "$total" ] || [ "$part" != "$expected" ]; then
    echo "error: $file is not part $expected of $total of the same report; give the parts of one report, in order" >&2
    exit 1
  fi
  chars="$(LC_ALL=en_US.UTF-8 wc -m < "$file" | tr -d '[:space:]')"
  if [ "$chars" -gt "$MAX_CHARS" ]; then
    echo "error: $file is $chars characters; GitHub allows $MAX_CHARS per comment." >&2
    exit 1
  fi
  expected=$((expected + 1))
done

if [ "$((expected - 1))" != "$total" ]; then
  echo "error: got $((expected - 1)) of $total parts" >&2
  exit 1
fi

for file in "$@"; do
  gh api --method POST "repos/{owner}/{repo}/issues/${pr}/comments" \
    -F "body=@${file}" --jq '"created " + .html_url'
done
