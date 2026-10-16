#!/usr/bin/env bash
# List the test names a range of commits added or changed that make a broad claim: "every",
# "all", "each", "always", "never", "any", "only", "no", "whole", "complete", "fully",
# "ensures", "guarantees". A broad name is read as a promise; the next review grades it
# against what the test checks.
#
# Usage: broad-test-names.sh <from> <to>   (run inside the repository)
#
# Recognises the common forms: it/test/describe/context("...") (JavaScript, TypeScript,
# Ruby), def test_... (Python), func Test... (Go), fn test_... (Rust). Prints one line per
# broad name, "<file>:<line>: <name>  [<words>]", or nothing.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <from> <to>" >&2
  exit 2
fi

git diff --unified=0 --no-color "$1" "$2" | awk '
  /^\+\+\+ / { file = substr($0, 5); sub(/^b\//, "", file); next }
  /^@@ / { split($3, a, ","); line = a[1]; sub(/^\+/, "", line); line--; next }
  /^\+/ {
    line++
    s = substr($0, 2); name = ""
    if (match(s, /(^|[^A-Za-z0-9_.])(it|test|describe|context|specify)(\.(only|skip|each\([^)]*\)|concurrent))*[ ]*\([ ]*["'"'"'`]/)) {
      rest = substr(s, RSTART + RLENGTH); q = substr(s, RSTART + RLENGTH - 1, 1)
      end = index(rest, q); if (end > 0) name = substr(rest, 1, end - 1)
    } else if (match(s, /def test_[A-Za-z0-9_]+/)) {
      name = substr(s, RSTART + 9, RLENGTH - 9); gsub(/_/, " ", name)
    } else if (match(s, /func Test[A-Za-z0-9_]+/)) {
      name = substr(s, RSTART + 9, RLENGTH - 9)
    } else if (match(s, /fn test_[A-Za-z0-9_]+/)) {
      name = substr(s, RSTART + 8, RLENGTH - 8); gsub(/_/, " ", name)
    }
    if (name == "") next
    # camelCase names (Go, Java) become words: "AlwaysUTC" is "Always UTC".
    words = name; if (words !~ / /) { gsub(/[A-Z][a-z]*/, " &", words); gsub(/_/, " ", words) }
    low = tolower(words); words = ""
    n = split("every all each always never any only no none whole entire complete completely fully ensures guarantees", w, " ")
    for (i = 1; i <= n; i++) if (match(" " low " ", "[^a-z]" w[i] "[^a-z]")) words = words (words == "" ? "" : ", ") w[i]
    if (words != "") print file ":" line ": " name "  [" words "]"
  }
'
