#!/usr/bin/env bash
# Check that the reviewers' outputs have every section their briefs require.
#
# Usage: check-outputs.sh <run-dir>
#
# A reviewer writes findings/<name>.md, or, when a large PR is split into parts,
# findings/<name>--<k>.md for each part k (and no unsplit file). Every file needs the
# sections; a part's finding IDs must be numbered from k*100+1 so that parts never share an
# ID.
#
# Prints one line per output file: ok, or what is wrong. Exits 1 when anything is missing
# or wrong; send that reviewer (or part) back to finish.

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

check_file() {
  local reviewer="$1" file="$2" part="${3:-}" problems="" heading id n low high
  while IFS= read -r heading; do
    grep -qxF "$heading" "$file" || problems="$problems
  missing section: $heading"
  done < <(required "$reviewer")
  if [ -n "$part" ]; then
    low=$((part * 100 + 1))
    high=$((part * 100 + 99))
    while IFS= read -r id; do
      n="${id##*-}"
      n="${n%%[a-z]*}"
      if [ "$n" -lt "$low" ] || [ "$n" -gt "$high" ]; then
        problems="$problems
  finding $id is outside this part's range ($low to $high)"
      fi
    done < <(grep -oE '^### [A-Z]+-[0-9]+[a-z]?:' "$file" | sed 's/^### //; s/:$//')
  fi
  if [ -n "$problems" ]; then
    echo "$(basename "$file"):$problems"
    status=1
  else
    echo "$(basename "$file"): ok"
  fi
}

for reviewer in standards code-smells spec-alignment test-adequacy; do
  whole="$dir/$reviewer.md"
  parts="$(ls "$dir/$reviewer--"*.md 2>/dev/null || true)"
  if [ -n "$parts" ] && [ -e "$whole" ]; then
    echo "$reviewer: both an unsplit output and parts exist; keep one or the other"
    status=1
  fi
  if [ -n "$parts" ]; then
    while IFS= read -r f; do
      part="$(basename "$f" .md)"
      part="${part##*--}"
      case "$part" in
        '' | *[!0-9]*) echo "$(basename "$f"): the part must be a number (<name>--<k>.md)"; status=1; continue ;;
      esac
      check_file "$reviewer" "$f" "$part"
    done <<< "$parts"
  elif [ -s "$whole" ]; then
    check_file "$reviewer" "$whole"
  else
    echo "$reviewer: output missing ($whole)"
    status=1
  fi
done

exit "$status"
