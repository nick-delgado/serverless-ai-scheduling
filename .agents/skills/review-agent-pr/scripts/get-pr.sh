#!/usr/bin/env bash
# Fetch everything the review needs to know about a PR, using GitHub's REST API only.
#
# Usage: get-pr.sh <pr-number> <run-dir>
#
# Writes into <run-dir>:
#   pr.json       the pull request (REST object: title, body, html_url, user, state, draft,
#                 base.ref, base.sha, head.ref, head.sha, additions, deletions, changed_files)
#   files.json    the changed files, one JSON object per line (filename, status, additions,
#                 deletions)
#   commits.txt   the PR's commits, oldest first: short sha, then the full message
#   diff.patch    the PR's diff
#   ci.txt        the checks and statuses reported on the head commit
# Prints a summary: head and base, size, CI state, and the issues the PR says it closes.
#
# Only REST calls are used (no GraphQL, no gh pr/issue subcommands), so this also runs where
# GraphQL is blocked. Run from inside a clone of the PR's repository.

set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -d "$2" ]; then
  echo "usage: $(basename "$0") <pr-number> <run-dir>" >&2
  exit 2
fi

pr="$1"
run="$2"

case "$pr" in '' | *[!0-9]*) echo "error: PR number must be numeric, got '$pr'" >&2; exit 2 ;; esac

gh api "repos/{owner}/{repo}/pulls/${pr}" > "$run/pr.json"
pr_field() { gh api "repos/{owner}/{repo}/pulls/${pr}" --jq "$1"; }

head_sha="$(pr_field '.head.sha')"

gh api --paginate "repos/{owner}/{repo}/pulls/${pr}/files" \
  --jq '.[] | {filename, status, additions, deletions}' > "$run/files.json"

gh api --paginate "repos/{owner}/{repo}/pulls/${pr}/commits" \
  --jq '.[] | "======== \(.sha[0:7]) ========\n\(.commit.message)\n"' > "$run/commits.txt"

gh api "repos/{owner}/{repo}/pulls/${pr}" -H "Accept: application/vnd.github.diff" > "$run/diff.patch"

{
  gh api --paginate "repos/{owner}/{repo}/commits/${head_sha}/check-runs" \
    --jq '.check_runs[] | "check\t\(.name)\t\(.status)\t\(.conclusion // "-")\t\(.html_url)"'
  gh api "repos/{owner}/{repo}/commits/${head_sha}/status" \
    --jq '.statuses[] | "status\t\(.context)\t\(.state)\t-\t\(.target_url // "")"'
} > "$run/ci.txt"

ci_state() {
  if [ ! -s "$run/ci.txt" ]; then
    echo "none reported"
    return
  fi
  if awk -F'\t' '($1 == "check" && $4 ~ /^(failure|timed_out|cancelled|action_required|startup_failure)$/) || ($1 == "status" && $3 ~ /^(failure|error)$/) { found = 1 } END { exit !found }' "$run/ci.txt"; then
    echo "failing: $(awk -F'\t' '($1 == "check" && $4 ~ /^(failure|timed_out|cancelled|action_required|startup_failure)$/) || ($1 == "status" && $3 ~ /^(failure|error)$/) { printf "%s%s", sep, $2; sep = ", " }' "$run/ci.txt")"
  elif awk -F'\t' '($1 == "check" && $3 != "completed") || ($1 == "status" && $3 == "pending") { found = 1 } END { exit !found }' "$run/ci.txt"; then
    echo "pending"
  else
    echo "passing ($(awk -F'\t' '{ printf "%s%s", sep, $2; sep = ", " }' "$run/ci.txt"))"
  fi
}

# Issues the PR says it closes: GitHub's closing keywords in the description and the commit
# messages. (The linked-issue field itself is only available through GraphQL.)
closes="$(
  { pr_field '.body // ""'; cat "$run/commits.txt"; } |
    grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+#[0-9]+' |
    grep -oE '#[0-9]+' | sort -u -t'#' -k2 -n | tr '\n' ' ' || true
)"

echo "pr: #${pr} $(pr_field '.title')"
echo "url: $(pr_field '.html_url')"
echo "state: $(pr_field 'if .merged_at then "merged" else .state end')$(pr_field 'if .draft then " (draft)" else "" end')"
echo "head: $(pr_field '.head.ref') @ ${head_sha}"
echo "base: $(pr_field '.base.ref') @ $(pr_field '.base.sha')"
echo "size: $(pr_field '"\(.changed_files) files, +\(.additions) -\(.deletions), \(.commits) commits"')"
echo "ci: $(ci_state)"
echo "closes: ${closes:-none found}"
