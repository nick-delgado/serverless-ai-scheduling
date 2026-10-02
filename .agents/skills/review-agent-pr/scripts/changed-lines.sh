#!/usr/bin/env bash
# List the lines of the PR head that changed since the previously reviewed commit.
#
# Usage: changed-lines.sh <run-dir> <previous-commit>
#
# Writes <run-dir>/changed-lines.txt: one line per changed file, "<path> <ranges>", where the
# ranges are lines of the file at the PR head (for example "src/a.ts 12-30,88,140-152"). A
# file added since the previous review reads "<path> all". A finding whose location falls in
# these ranges is in changed code; anywhere else, it is in code unchanged since the last
# review. Prints a one-line summary.

set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -d "$1/worktree" ]; then
  echo "usage: $(basename "$0") <run-dir> <previous-commit>" >&2
  echo "(the run directory must contain the PR worktree)" >&2
  exit 2
fi

run="$1"
prev="$2"
tree="$run/worktree"
out="$run/changed-lines.txt"

git -C "$tree" cat-file -e "${prev}^{commit}" 2>/dev/null || {
  echo "error: commit $prev is not in the worktree's history (rebased or force-pushed?)" >&2
  exit 1
}

{
  git -C "$tree" diff --name-only --diff-filter=A "$prev" HEAD | sed 's/$/ all/'
  git -C "$tree" diff -U0 --diff-filter=MR "$prev" HEAD | awk '
    function flush() { if (file != "" && ranges != "") print file " " ranges; ranges = "" }
    /^\+\+\+ b\// { flush(); file = substr($0, 7); next }
    /^@@ / {
      # @@ -a,b +c,d @@ : the new side starts at c and spans d lines (d = 0: a pure deletion)
      split($3, n, ","); start = substr(n[1], 2) + 0; len = (n[2] == "" ? 1 : n[2] + 0)
      if (len == 0) { r = start "" } else if (len == 1) { r = start "" } else { r = start "-" (start + len - 1) }
      ranges = (ranges == "" ? r : ranges "," r)
    }
    END { flush() }'
} > "$out"

echo "changed since ${prev:0:7}: $(wc -l < "$out" | tr -d ' ') files, listed in $out"
