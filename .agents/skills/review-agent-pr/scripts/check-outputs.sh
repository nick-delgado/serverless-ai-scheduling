#!/usr/bin/env bash
# Check that the reviewers' outputs have every section their briefs require.
#
# Usage: check-outputs.sh <run-dir>
#
# Prints one line per reviewer: ok, or the sections it is missing. Exits 1 when any
# reviewer output is missing or incomplete; send that reviewer back to finish.

set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1/findings" ]; then
  echo "usage: $(basename "$0") <run-dir>" >&2
  exit 2
fi

dir="$1/findings"
status=0

# The section headings each reviewer's output must contain, one per line.
required() {
  printf '%s\n' "## 1. Findings" "## 2. Coverage ledger" "### Sources read" "### Checks performed" "### Searches run" "## 3. Not reviewed"
  case "$1" in
    spec-alignment) printf '%s\n' "### Spec traceability" "### Unrequested changes" ;;
    test-adequacy) printf '%s\n' "### Behaviour coverage" ;;
  esac
}

for reviewer in standards code-smells spec-alignment test-adequacy; do
  file="$dir/$reviewer.md"
  if [ ! -s "$file" ]; then
    echo "$reviewer: output missing ($file)"
    status=1
    continue
  fi
  missing=""
  while IFS= read -r heading; do
    grep -qxF "$heading" "$file" || missing="$missing
  $heading"
  done < <(required "$reviewer")
  if [ -n "$missing" ]; then
    echo "$reviewer: missing sections:$missing"
    status=1
  else
    echo "$reviewer: ok"
  fi
done

exit "$status"
