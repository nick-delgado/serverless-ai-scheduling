#!/usr/bin/env bash
# Save a GitHub issue and all its comments as a markdown file, using the REST API only.
#
# Usage: get-issue.sh <issue-number> <run-dir>
#
# Writes <run-dir>/spec/issue-<number>.md and prints its path. Runs where GraphQL is blocked.
# Run from inside a clone of the repository.

set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -d "$2" ]; then
  echo "usage: $(basename "$0") <issue-number> <run-dir>" >&2
  exit 2
fi

n="$1"
case "$n" in '' | *[!0-9]*) echo "error: issue number must be numeric, got '$n'" >&2; exit 2 ;; esac

mkdir -p "$2/spec"
out="$2/spec/issue-${n}.md"

{
  gh api "repos/{owner}/{repo}/issues/${n}" --jq '
    "# Issue #\(.number): \(.title)\n\n" +
    "- URL: \(.html_url)\n" +
    "- State: \(.state)\n" +
    "- Author: \(.user.login), \(.created_at)\n" +
    "- Labels: \([.labels[].name] | join(", "))\n" +
    (if .pull_request then "- Note: this number is a pull request, not an issue\n" else "" end) +
    "\n## Body\n\n\(.body // "(empty)")\n\n## Comments\n"'
  gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" \
    --jq '.[] | "\n### \(.user.login), \(.created_at)\n\n\(.body)\n"'
} > "$out"

echo "$out"
