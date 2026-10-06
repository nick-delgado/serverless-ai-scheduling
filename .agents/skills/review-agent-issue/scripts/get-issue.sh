#!/usr/bin/env bash
# Save a GitHub issue and all its comments as a markdown file, using the REST API only.
#
# Usage: get-issue.sh <issue-number> <run-dir> [--background]
#
# Without --background (the task's own issue): writes <run-dir>/spec/issue-<number>.md with
# the description and every comment. Readers must read it to its end.
#
# With --background (an issue or PR the spec links to, read for context): writes
# <run-dir>/spec/background/issue-<number>.md, trimmed to what can be spec:
# - an issue: its description and the comments people wrote, without the harness's own
#   comments (reports, readiness reviews, process logs), whose settled answers are already
#   in the description;
# - a pull request: its description only, not its review traffic;
# - the agent-process tracking issue: a one-line note, never its content (it is the process
#   log, not spec).
# Background files are searched and read where the spec points to them, not read whole.
#
# Prints the path and its line count. Run from inside a clone of the repository.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || [ ! -d "$2" ] || { [ "$#" -eq 3 ] && [ "$3" != "--background" ]; }; then
  echo "usage: $(basename "$0") <issue-number> <run-dir> [--background]" >&2
  exit 2
fi

n="$1"
case "$n" in '' | *[!0-9]*) echo "error: issue number must be numeric, got '$n'" >&2; exit 2 ;; esac
background="${3:-}"

if [ -n "$background" ]; then
  mkdir -p "$2/spec/background"
  out="$2/spec/background/issue-${n}.md"
else
  mkdir -p "$2/spec"
  out="$2/spec/issue-${n}.md"
fi

header='
  "# Issue #\(.number): \(.title)\n\n" +
  "- URL: \(.html_url)\n" +
  "- State: \(.state)\n" +
  "- Author: \(.user.login), \(.created_at)\n" +
  "- Labels: \([.labels[].name] | join(", "))\n"'

if [ -z "$background" ]; then
  {
    gh api "repos/{owner}/{repo}/issues/${n}" --jq "$header"' +
      (if .pull_request then "- Note: this number is a pull request, not an issue\n" else "" end) +
      "\n## Body\n\n\(.body // "(empty)")\n\n## Comments\n"'
    gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" \
      --jq '.[] | "\n### \(.user.login), \(.created_at)\n\n\(.body)\n"'
  } > "$out"
else
  kind="$(gh api "repos/{owner}/{repo}/issues/${n}" --jq 'if .pull_request then "pr" elif ([.labels[].name] | index("agent-process")) then "tracking" else "issue" end')"
  case "$kind" in
    tracking)
      gh api "repos/{owner}/{repo}/issues/${n}" --jq '"# Issue #\(.number): \(.title)\n\nThe agent-process tracking issue: the process log, not spec. Not saved.\n"' > "$out" ;;
    pr)
      gh api "repos/{owner}/{repo}/issues/${n}" --jq "$header"' +
        "- Note: a pull request; its description only, not its review comments\n\n## Body\n\n\(.body // "(empty)")\n"' > "$out" ;;
    issue)
      {
        gh api "repos/{owner}/{repo}/issues/${n}" --jq "$header"' + "\n## Body\n\n\(.body // "(empty)")\n\n## Comments (people only)\n"'
        gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" \
          --jq '.[] | select(.body | startswith("<!-- agent-pr-review:") | not) | "\n### \(.user.login), \(.created_at)\n\n\(.body)\n"'
      } > "$out" ;;
  esac
fi

echo "$out ($(awk 'END { print NR }' "$out") lines)"
