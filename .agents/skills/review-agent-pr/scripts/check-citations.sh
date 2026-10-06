#!/usr/bin/env bash
# Check the file:line citations in review outputs against the code at the PR head.
#
# Usage: check-citations.sh [--strict] <run-dir> <file>...
#
# Every citation of the form path/to/file.ext:N or path/to/file.ext:N-M in the given files
# is resolved against <run-dir>/worktree (or <run-dir> itself, for spec files) and checked
# to be within the file's length. A bare file name or partial path is resolved when exactly
# one tracked file in the worktree ends with it. Citations of files that cannot be found are listed but not counted as invalid:
# they may name something outside the repository.
#
# Prints a summary and every invalid citation. Exits 1 when any citation is invalid, and with
# --strict also when any citation cannot be resolved to a file (the verifier's output must
# cite full paths).

set -euo pipefail

strict=no
if [ "${1:-}" = "--strict" ]; then
  strict=yes
  shift
fi

if [ "$#" -lt 2 ] || [ ! -d "$1/worktree" ]; then
  echo "usage: $(basename "$0") <run-dir> <file>..." >&2
  echo "(the run directory must contain the PR worktree)" >&2
  exit 2
fi

run="$(cd "$1" && pwd)"
shift
tree="$run/worktree"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for f in "$@"; do
  [ -f "$f" ] || { echo "error: no such file $f" >&2; exit 2; }
  grep -oE '[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+:[0-9]+(-[0-9]+)?' "$f" |
    sed "s|^|$(basename "$f")	|" >> "$tmp" || true
done

checked=0
invalid=0
unresolved=0
report=""
unresolved_list=""

while IFS="$(printf '\t')" read -r source citation; do
  path="${citation%:*}"
  range="${citation##*:}"
  start="${range%-*}"
  end="${range#*-}"
  path="${path#./}"

  target=""
  if [ -f "$tree/$path" ]; then
    target="$tree/$path"
  elif [ -f "$run/$path" ]; then
    target="$run/$path"
  else
    # A bare file name or a partial path: resolve it when exactly one tracked file ends with it.
    case "$path" in
      /*) ;;
      *)
        matches="$(cd "$tree" && git ls-files | grep -E "(^|/)$(printf '%s' "$path" | sed 's/[.]/\\./g')\$" || true)"
        if [ -n "$matches" ] && [ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" -eq 1 ]; then
          target="$tree/$matches"
        fi
        ;;
    esac
  fi

  if [ -z "$target" ]; then
    unresolved=$((unresolved + 1))
    unresolved_list="$unresolved_list
  $source: $citation"
    continue
  fi

  checked=$((checked + 1))
  length="$(awk 'END { print NR }' "$target")"
  if [ "$start" -lt 1 ] || [ "$end" -lt "$start" ] || [ "$end" -gt "$length" ]; then
    invalid=$((invalid + 1))
    report="$report
  $source: $citation (the file has $length lines)"
  fi
done < <(sort -u "$tmp")

echo "citations checked: $checked, invalid: $invalid, not resolvable to a file: $unresolved"
if [ "$invalid" -gt 0 ]; then
  echo "invalid citations (line numbers must be lines of the file at the PR head, not positions in diff.patch):$report"
fi
if [ "$unresolved" -gt 0 ]; then
  echo "not resolvable (not checked):$unresolved_list"
fi

[ "$invalid" -eq 0 ] || exit 1
[ "$strict" = "no" ] || [ "$unresolved" -eq 0 ]
