#!/usr/bin/env bash
# Measure how much a PR's own changes moved between two of its commits, separating source
# from tests and other files.
#
# Usage: diff-size.sh <from-commit> <to-commit> [<repo-dir>] [<base-branch>]
#
# Compares the PR's own diff at <to-commit> (from its merge base with the base branch) with
# its own diff at <from-commit>. Lines the PR adds now but did not add then, and lines it
# added then but no longer does, are the change. Changes that came in from the base branch
# (by merging it into the PR, or by a rebase) do not count.
#
# Prints, one per line:
#   source <new> <dropped> <changed>   source files (not tests, docs, generated or lock files)
#   tests <new> <dropped> <changed>    test files and snapshots
#   other <new> <dropped> <changed>    docs, configuration, lock and generated files
#   new-source <path> <lines>          each source file the PR adds now but did not then
#   pr-source <lines>                  source lines the PR adds at <to-commit>
#   base-moved <commits>               commits the base branch gained between the two
#
# The same script ships with the review-agent-pr and address-pr-review skills; keep the two
# copies identical.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "usage: $(basename "$0") <from-commit> <to-commit> [<repo-dir>] [<base-branch>]" >&2
  exit 2
fi

from="$1"
to="$2"
repo="${3:-.}"
base="${4:-}"

if [ -z "$base" ]; then
  base="$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  [ -n "$base" ] || base="main"
fi
git -C "$repo" fetch -q origin "$base" 2>/dev/null || true
git -C "$repo" cat-file -e "${from}^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin "$from" 2>/dev/null || true

# The base: the remote branch, or (for checking an old PR after the fact) any commit.
if git -C "$repo" rev-parse --verify --quiet "origin/$base^{commit}" > /dev/null; then
  base_ref="origin/$base"
else
  base_ref="$base"
fi
base_to="$(git -C "$repo" merge-base "$base_ref" "$to")"
base_from="$(git -C "$repo" merge-base "$base_ref" "$from")"

{
  git -C "$repo" diff --no-color -U0 "$base_from" "$from" | sed 's/^/OLD/'
  git -C "$repo" diff --no-color -U0 "$base_to" "$to" | sed 's/^/NEW/'
} | awk '
  function kind(p) {
    if (p ~ /(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures|__snapshots__)\// ||
        p ~ /\.(test|spec)\.[A-Za-z0-9]+$/ || p ~ /_test\.[A-Za-z0-9]+$/ ||
        p ~ /(^|\/)test_[^\/]*\.py$/ || p ~ /\.snap$/) return "tests"
    if (p ~ /\.(md|mdx|txt|rst|adoc|ya?ml|json|toml|ini|cfg|lock|svg|png|jpg|gif)$/ ||
        p ~ /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock)$/ ||
        p ~ /(^|\/)(dist|build|vendor|node_modules|generated|gen)\// || p ~ /(^|\/)\./ ) return "other"
    return "source"
  }
  /^OLD\+\+\+ / { ofile = substr($0, 10); oldfiles[ofile] = 1; next }
  /^OLD\+/ { old[ofile SUBSEP substr($0, 5)]++; next }
  /^OLD/ { next }
  /^NEW\+\+\+ / { file = substr($0, 10); next }
  /^NEW\+/ {
    k = kind(file)
    if (k == "source") prsource++
    key = file SUBSEP substr($0, 5)
    if (old[key] > 0) old[key]--; else { added[k]++; if (!(file in oldfiles)) newfile[file]++ }
    next
  }
  END {
    for (key in old) if (old[key] > 0) { split(key, parts, SUBSEP); dropped[kind(parts[1])] += old[key] }
    split("source tests other", ks, " ")
    for (i = 1; i <= 3; i++) printf "%s %d %d %d\n", ks[i], added[ks[i]], dropped[ks[i]], added[ks[i]] + dropped[ks[i]]
    for (f in newfile) if (kind(f) == "source") printf "new-source %s %d\n", f, newfile[f]
    printf "pr-source %d\n", prsource
  }
'

echo "base-moved $(git -C "$repo" rev-list --count "$base_from..$base_to")"
