#!/usr/bin/env bash
# Measure a change between two commits, separating source from tests and other files.
#
# Usage: diff-size.sh <from-commit> <to-commit> [<repo-dir>]
#
# Prints, one per line:
#   source <added> <deleted> <changed>   source files (not tests, docs, generated or lock files)
#   tests <added> <deleted> <changed>    test files and snapshots
#   other <added> <deleted> <changed>    docs, configuration, lock and generated files
#   new-source <path> <lines>            each source file added between the two commits
#   pr-source <lines>                    source lines added by the whole PR at <to-commit>,
#                                        measured from its merge base with the default branch
#                                        (only when origin/HEAD or origin/main is known)
#
# The same script ships with the review-agent-pr and address-pr-review skills; keep the two
# copies identical.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $(basename "$0") <from-commit> <to-commit> [<repo-dir>]" >&2
  exit 2
fi

from="$1"
to="$2"
repo="${3:-.}"

# Classify a path: test, other or source.
classify='
  function kind(p) {
    if (p ~ /(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures|__snapshots__)\// ||
        p ~ /\.(test|spec)\.[A-Za-z0-9]+$/ || p ~ /_test\.[A-Za-z0-9]+$/ ||
        p ~ /(^|\/)test_[^\/]*\.py$/ || p ~ /\.snap$/) return "tests"
    if (p ~ /\.(md|mdx|txt|rst|adoc|ya?ml|json|toml|ini|cfg|lock|svg|png|jpg|gif)$/ ||
        p ~ /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock)$/ ||
        p ~ /(^|\/)(dist|build|vendor|node_modules|generated|gen)\// || p ~ /(^|\/)\./ ) return "other"
    return "source"
  }'

git -C "$repo" diff --numstat "$from" "$to" | awk -F'\t' "$classify"'
  $1 != "-" { k = kind($3); add[k] += $1; del[k] += $2 }
  END {
    split("source tests other", ks, " ")
    for (i = 1; i <= 3; i++) printf "%s %d %d %d\n", ks[i], add[ks[i]], del[ks[i]], add[ks[i]] + del[ks[i]]
  }'

git -C "$repo" diff --numstat --diff-filter=A "$from" "$to" | awk -F'\t' "$classify"'
  $1 != "-" && kind($3) == "source" { printf "new-source %s %d\n", $3, $1 }'

base_ref=""
for ref in origin/HEAD origin/main origin/master; do
  if git -C "$repo" rev-parse --verify --quiet "$ref" > /dev/null; then base_ref="$ref"; break; fi
done
if [ -n "$base_ref" ]; then
  base="$(git -C "$repo" merge-base "$base_ref" "$to" 2>/dev/null || true)"
  if [ -n "$base" ]; then
    git -C "$repo" diff --numstat "$base" "$to" | awk -F'\t' "$classify"'
      $1 != "-" && kind($3) == "source" { n += $1 } END { printf "pr-source %d\n", n }'
  fi
fi
