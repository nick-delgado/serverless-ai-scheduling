#!/usr/bin/env bash
# List the lines of the PR's own changes that are new since the previously reviewed commit.
#
# Usage: changed-lines.sh <run-dir> <previous-commit> [<base-branch>]
#
# Compares the PR's own diff now (the base branch's merge base .. the PR head) with the PR's
# own diff at the previous review (merge base .. previous commit). A line the PR adds now
# that it did not add then is changed: a fix, an implemented decision, or a conflict
# resolution. Changes that came in from the base branch (by merging it into the PR) are not,
# because they are part of the base on both sides; the same goes after a rebase.
#
# Writes <run-dir>/changed-lines.txt: one line per file, "<path> <ranges>", the ranges being
# lines of the file at the PR head ("src/a.ts 12-30,88"). Also writes
# <run-dir>/base-changes.txt: the files the base branch changed between the two merge bases,
# with line counts, for the check of changes on the base branch that the PR depends on.
# Prints a one-line summary. Base branch defaults to the remote's default branch.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || [ ! -d "$1/worktree" ]; then
  echo "usage: $(basename "$0") <run-dir> <previous-commit> [<base-branch>]" >&2
  echo "(the run directory must contain the PR worktree)" >&2
  exit 2
fi

run="$1"
prev="$2"
base="${3:-}"
tree="$run/worktree"
out="$run/changed-lines.txt"

if [ -z "$base" ]; then
  base="$(git -C "$tree" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  [ -n "$base" ] || base="main"
fi
git -C "$tree" fetch -q origin "$base" 2>/dev/null || true
# The base: the remote branch, or (for checking an old PR after the fact) any commit.
if git -C "$tree" rev-parse --verify --quiet "origin/$base^{commit}" > /dev/null; then
  base_ref="origin/$base"
else
  base_ref="$base"
fi

if ! git -C "$tree" cat-file -e "${prev}^{commit}" 2>/dev/null; then
  # After a force-push the old commit is not in the branch's history; GitHub still serves it
  # by its full id.
  git -C "$tree" fetch -q origin "$prev" 2>/dev/null || true
fi
git -C "$tree" cat-file -e "${prev}^{commit}" 2>/dev/null || {
  echo "error: commit $prev cannot be fetched; review as a first review" >&2
  exit 1
}

base_now="$(git -C "$tree" merge-base "$base_ref" HEAD)"
base_prev="$(git -C "$tree" merge-base "$base_ref" "$prev")"

{
  git -C "$tree" diff --no-color -U0 "$base_prev" "$prev" | sed 's/^/OLD/'
  git -C "$tree" diff --no-color -U0 "$base_now" HEAD | sed 's/^/NEW/'
} | awk '
  function flush() { if (file != "" && ranges != "") print file " " ranges; ranges = ""; last = -10; start = -1 }
  function add(n) {
    if (n == last + 1) { last = n; return }
    close_range()
    start = n; last = n
  }
  function close_range() {
    if (start < 0) return
    r = (start == last ? start "" : start "-" last)
    ranges = (ranges == "" ? r : ranges "," r)
    start = -1
  }
  /^OLD\+\+\+ / { ofile = substr($0, 10); next }
  /^OLD\+/ { old[ofile SUBSEP substr($0, 5)]++; next }
  /^OLD/ { next }
  /^NEW\+\+\+ / { close_range(); flush(); file = substr($0, 10); next }
  /^NEW@@ / { split($3, n, ","); line = substr(n[1], 2) + 0; next }
  /^NEW\+/ {
    key = file SUBSEP substr($0, 5)
    if (old[key] > 0) old[key]--; else add(line)
    line++
    next
  }
  END { close_range(); flush() }
' > "$out"

# What the base branch changed between the two reviews.
git -C "$tree" diff --numstat "$base_prev" "$base_now" | awk -F'\t' '{ printf "%s +%s -%s\n", $3, $1, $2 }' > "$run/base-changes.txt"

echo "changed in the PR's own diff since ${prev:0:7}: $(wc -l < "$out" | tr -d ' ') files ($out); the base branch changed $(wc -l < "$run/base-changes.txt" | tr -d ' ') files since then ($run/base-changes.txt)"
