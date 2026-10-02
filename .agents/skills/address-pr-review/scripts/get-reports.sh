#!/usr/bin/env bash
# Fetch every agent PR review report on a PR, reassembling reports that were posted in parts.
#
# Usage: get-reports.sh <pr-number> <out-dir>
#
# A report is one or more consecutive comments whose first line is
#   <!-- agent-pr-review:report sha=<reviewed commit> run=<run id> part=<k>/<n> -->
# Reports from before reports could have parts carry no run or part, and are one comment.
#
# Writes <out-dir>/<seq>-<sha7>.md for each report, oldest first, with the parts joined in
# order, and prints one tab-separated line per report:
#   <file>  <reviewed sha>  <parts>  <URL of the first comment>  <posted at>
# A report with a part missing is skipped with a warning on stderr.
# Uses the REST API only. Run from inside a clone of the PR's repository.
#
# The same script ships with the review-agent-pr and address-pr-review skills; keep the two
# copies identical.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <pr-number> <out-dir>" >&2
  exit 2
fi

pr="$1"
out="$2"
case "$pr" in '' | *[!0-9]*) echo "error: PR number must be numeric, got '$pr'" >&2; exit 2 ;; esac
mkdir -p "$out"

# id, time, URL and first line of every report comment, oldest first.
list="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq '.[] | select(.body | startswith("<!-- agent-pr-review:report")) | "\(.id)\t\(.created_at)\t\(.html_url)\t\(.body | split("\n")[0])"' |
    sort -t "$(printf '\t')" -k2,2
)"

[ -n "$list" ] || exit 0

# Group into reports: key = run id (or the comment id for a single-comment report).
groups="$(
  printf '%s\n' "$list" | awk -F'\t' '
    {
      line = $4; run = ""; part = 1; total = 1; sha = ""
      if (match(line, /run=[^ ]+/)) run = substr(line, RSTART + 4, RLENGTH - 4)
      if (match(line, /part=[0-9]+\/[0-9]+/)) {
        split(substr(line, RSTART + 5, RLENGTH - 5), p, "/"); part = p[1]; total = p[2]
      }
      if (match(line, /sha=[0-9a-f]+/)) sha = substr(line, RSTART + 4, RLENGTH - 4)
      key = (run != "" ? run : "c" $1)
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", key, part, total, $1, $2, $3, sha
    }'
)"

seq=0
for key in $(printf '%s\n' "$groups" | awk -F'\t' '!seen[$1]++ { print $1 }'); do
  members="$(printf '%s\n' "$groups" | awk -F'\t' -v k="$key" '$1 == k' | sort -t "$(printf '\t')" -k2,2n)"
  total="$(printf '%s\n' "$members" | head -n 1 | cut -f3)"
  have="$(printf '%s\n' "$members" | cut -f2 | sort -un | tr '\n' ' ')"
  want="$(seq 1 "$total" | tr '\n' ' ')"
  if [ "$have" != "$want" ]; then
    echo "warning: report run ${key} has parts ${have}of ${total}; skipped" >&2
    continue
  fi
  seq=$((seq + 1))
  first="$(printf '%s\n' "$members" | head -n 1)"
  sha="$(printf '%s' "$first" | cut -f7)"
  id1="$(printf '%s' "$first" | cut -f4)"
  body1="$(gh api "repos/{owner}/{repo}/issues/comments/${id1}" --jq '.body')"
  if [ -z "$sha" ]; then
    # Older reports named the commit only in their header.
    sha="$(printf '%s\n' "$body1" | sed -nE 's/.*\*\*(Head|Reviewed commit):\*\* \[?`([0-9a-f]+)`.*/\2/p' | head -n 1)"
  fi
  file="$out/$(printf '%03d' "$seq")-${sha:0:7}.md"
  : > "$file"
  while IFS="$(printf '\t')" read -r _ part _ id _ _ _; do
    if [ "$id" = "$id1" ]; then
      printf '%s\n' "$body1" >> "$file"
    else
      gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.body' >> "$file"
    fi
    printf '\n' >> "$file"
  done <<< "$members"
  printf '%s\t%s\t%s\t%s\t%s\n' "$file" "$sha" "$total" "$(printf '%s' "$first" | cut -f6)" "$(printf '%s' "$first" | cut -f5)"
done
