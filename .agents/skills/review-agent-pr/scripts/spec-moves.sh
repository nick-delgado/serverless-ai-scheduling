#!/usr/bin/env bash
# Show whether the spec moved under the work: changes on the base branch to the project's
# direction documents since the PR's work began, and since a readiness review settled the
# PR's issue.
#
# Usage: spec-moves.sh <run-dir> <base-branch> <direction-path>...
#
# <direction-path> are the direction documents (PRD, ADRs, architecture, roadmap) as paths
# in the repository, files or directories. Reads <run-dir>/worktree (the PR head) and the
# issue files <run-dir>/spec/issue-*.md (from get-issue.sh).
#
# Writes <run-dir>/spec-moves.md     what the manifest lists: readiness state of each issue,
#                                    and the direction-document commits in each window
#        <run-dir>/spec-moves.patch  the diff of those documents over the longer window
# Prints a one-line summary per window.

set -euo pipefail

if [ "$#" -lt 2 ] || [ ! -d "$1/worktree" ]; then
  echo "usage: $(basename "$0") <run-dir> <base-branch> <direction-path>..." >&2
  exit 2
fi

run="$(cd "$1" && pwd)"
base="$2"
shift 2
tree="$run/worktree"
out="$run/spec-moves.md"
patch="$run/spec-moves.patch"

git -C "$tree" fetch -q origin "$base" 2>/dev/null || true
base_ref="origin/$base"
git -C "$tree" rev-parse -q --verify "$base_ref" >/dev/null || { echo "error: $base_ref not found" >&2; exit 1; }

# Where the work began: the parent of the PR's earliest own commit on its first-parent line.
first="$(git -C "$tree" rev-list --first-parent --reverse "$base_ref..HEAD" | head -n 1)"
began=""
began_date=""
if [ -n "$first" ]; then
  began="$(git -C "$tree" rev-parse -q --verify "$first^1" 2>/dev/null || true)"
  began_date="$(git -C "$tree" log -1 --format=%aI "$first")"
fi

# The latest readiness round of each issue file, with its spec commit.
readiness=""
settled=""
for f in "$run"/spec/issue-*.md; do
  [ -f "$f" ] || continue
  num="$(basename "$f" .md)"; num="${num#issue-}"
  line="$(grep -E '^## Readiness (review|refresh) \(round [0-9]+\): ' "$f" | tail -n 1 || true)"
  if [ -z "$line" ]; then
    readiness="$readiness
- #$num: no readiness review"
    continue
  fi
  sha="$(grep -oE 'Spec commit: [0-9a-f]{40}' "$f" | tail -n 1 | sed 's/Spec commit: //' || true)"
  applied="no"
  grep -q '<!-- agent-pr-review:readiness-applied' "$f" && applied="yes"
  readiness="$readiness
- #$num: ${line#\#\# Readiness } · settled against \`${sha:0:7}\` · answers applied: $applied"
  # The earliest settled commit among the issues is the start of the readiness window.
  if [ -n "$sha" ] && git -C "$tree" cat-file -e "$sha^{commit}" 2>/dev/null; then
    if [ -z "$settled" ] || git -C "$tree" merge-base --is-ancestor "$sha" "$settled"; then settled="$sha"; fi
  fi
done
[ -n "$readiness" ] || readiness="
- No issue files (no linked issue)."

window() {
  local from="$1"
  if [ "$#" -lt 2 ]; then echo "(no direction documents named)"; return; fi
  shift
  local log
  log="$(git -C "$tree" log --format='- `%h` %ad %s' --date=short "$from..$base_ref" -- "$@" || true)"
  [ -n "$log" ] && printf '%s\n' "$log" || echo "None."
}

{
  echo "# Spec moves"
  echo
  echo "Direction documents checked: $(printf '`%s` ' "$@")"
  echo
  echo "## Readiness of the PR's issues"
  printf '%s\n' "$readiness" | sed '/^$/d'
  echo
  if [ -n "$began" ]; then
    echo "## Changed on \`$base\` since the work began (\`${began:0:7}\`, first commit $began_date)"
    window "$began" "$@"
  else
    echo "## Changed on \`$base\` since the work began"
    echo "Not determined: the PR has no commits of its own on its first-parent line."
  fi
  echo
  if [ -n "$settled" ]; then
    echo "## Changed on \`$base\` since the readiness review settled the issue (\`${settled:0:7}\`)"
    window "$settled" "$@"
  else
    echo "## Changed on \`$base\` since the readiness review settled the issue"
    echo "No readiness review with a spec commit."
  fi
} > "$out"

# The patch covers the longer of the two windows.
from="$began"
if [ -n "$settled" ] && { [ -z "$from" ] || git -C "$tree" merge-base --is-ancestor "$settled" "$from"; }; then from="$settled"; fi
if [ -n "$from" ] && [ "$#" -gt 0 ]; then
  git -C "$tree" diff "$from" "$base_ref" -- "$@" > "$patch"
else
  : > "$patch"
fi

since_work="$( [ -n "$began" ] && [ "$#" -gt 0 ] && git -C "$tree" rev-list --count "$began..$base_ref" -- "$@" || echo "n/a")"
since_ready="$( [ -n "$settled" ] && [ "$#" -gt 0 ] && git -C "$tree" rev-list --count "$settled..$base_ref" -- "$@" || echo "n/a")"
echo "direction-document commits since work began: $since_work"
echo "direction-document commits since readiness: $since_ready"
echo "written: $out, $patch"
