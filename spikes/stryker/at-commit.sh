#!/usr/bin/env bash
# The #140 coverage column at a historical commit (#113 trial, readiness review Q-2 (b)).
#
#   spikes/stryker/at-commit.sh <sha> <base>
#
# 1. Checks <sha> out in a throwaway worktree, .worktrees/113-at-<sha7>, and runs `npm ci` there.
# 2. Installs @vitest/coverage-v8 5.0.2 with --no-save when the commit predates #140 (the lockfile stays as it was).
# 3. Runs the whole suite with coverage, with `CI` unset (so the DynamoDB tests skip, as in every local run), passing
#    #140's coverage options on the command line (older vitest.config.ts files have none) plus `--coverage.reporter=text`
#    for the per-file report (the #94 review's P2).
# 4. Runs the changed-line gate, this checkout's scripts/coverage-changed.ts (from `main` at dd754fa), in the old
#    worktree against <base> (the merge base with `main` as it was when the PR merged).
# Outputs go to spikes/stryker/results/at-<sha7>/: coverage-text.txt (per-file), gate.txt (the gate's output and
# exit code). The worktree is left in place for the mutate.ts and Stryker runs; remove it with
# `git worktree remove --force .worktrees/113-at-<sha7>` when done.
set -uo pipefail
sha="$1"
base="$2"
here="$(cd "$(dirname "$0")" && pwd)"
spike_root="$(cd "$here/../.." && pwd)"
repo="$(git -C "$spike_root" rev-parse --path-format=absolute --git-common-dir)/.."
repo="$(cd "$repo" && pwd)"
short="${sha:0:7}"
wt="$repo/.worktrees/113-at-$short"
out="$here/results/at-$short"
mkdir -p "$out"

if [[ ! -d "$wt" ]]; then
  git -C "$repo" worktree add --detach "$wt" "$sha" >/dev/null
  (cd "$wt" && npm ci --no-audit --no-fund >/dev/null 2>&1)
fi
cd "$wt"
if [[ ! -d node_modules/@vitest/coverage-v8 ]]; then
  npm i --no-save --no-audit --no-fund @vitest/coverage-v8@5.0.2 >/dev/null 2>&1
fi
unset CI
start=$(date +%s)
npx vitest run --coverage.enabled --coverage.provider=v8 \
  --coverage.include='packages/*/src/**/*.{ts,tsx}' --coverage.include='services/*/src/**/*.{ts,tsx}' \
  --coverage.include='apps/*/src/**/*.{ts,tsx}' --coverage.include='scripts/*.ts' \
  --coverage.exclude='**/*.test.*' --coverage.exclude='**/*.d.ts' \
  --coverage.reporter=json --coverage.reporter=text --coverage.reportsDirectory=coverage \
  >"$out/vitest.log" 2>&1
echo "vitest exit $? in $(($(date +%s) - start)) s" >>"$out/vitest.log"
# The text reporter's table, without the test output above it.
sed -n '/^-*|-*|/,$p' "$out/vitest.log" >"$out/coverage-text.txt"
start=$(date +%s)
npx tsx "$spike_root/scripts/coverage-changed.ts" --base "$base" --coverage coverage/coverage-final.json >"$out/gate.txt" 2>&1
echo "gate exit $? in $(($(date +%s) - start)) s (base $base, head $sha)" >>"$out/gate.txt"
git status --short >"$out/worktree-status.txt"
tail -3 "$out/vitest.log"
cat "$out/gate.txt"
