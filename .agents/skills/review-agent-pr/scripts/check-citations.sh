#!/usr/bin/env bash
# Check the file:line citations in review outputs against the code at the PR head.
#
# Usage: check-citations.sh [--strict] [--expand] <run-dir> <file>...
#
# Every citation of the form path/to/file.ext:N or path/to/file.ext:N-M in the given files
# is resolved against <run-dir>/worktree (or <run-dir> itself, for spec files) and checked
# to be within the file's length. A bare file name or partial path is resolved when exactly
# one tracked file in the worktree ends with it. Citations of files that cannot be found are listed but not counted as invalid:
# they may name something outside the repository.
#
# A short path that several files end with is resolved when exactly one of them is among the
# PR's changed files (<run-dir>/files.json). With --expand, every short path that resolved
# is rewritten in the given files as its full path, so readers see which file is meant.
#
# Prints a summary and every invalid citation. Exits 1 when any citation is invalid, and with
# --strict also when any citation cannot be resolved to a file (the verifier's output must
# cite full paths).

set -euo pipefail

strict=no
expand=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict) strict=yes; shift ;;
    --expand) expand=yes; shift ;;
    *) break ;;
  esac
done

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
  matches=""
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
        elif [ -n "$matches" ] && [ -f "$run/files.json" ]; then
          # Several files end with it: the one the PR changed, if exactly one did.
          changed="$(printf '%s\n' "$matches" | while IFS= read -r m; do grep -qF "\"filename\":\"$m\"" "$run/files.json" && echo "$m"; done || true)"
          if [ -n "$changed" ] && [ "$(printf '%s\n' "$changed" | wc -l | tr -d ' ')" -eq 1 ]; then
            target="$tree/$changed"; matches="$changed"
          fi
        fi
        # A short path that resolved is rewritten as the full one (--expand).
        if [ -n "$target" ] && [ "$expand" = "yes" ]; then
          printf '%s\t%s:%s\n' "$citation" "${target#$tree/}" "$range" >> "$tmp.expand"
        fi
        ;;
    esac
  fi

  if [ -z "$target" ]; then
    unresolved=$((unresolved + 1))
    hint=""
    if [ -n "${matches:-}" ]; then
      # A short path that more than one file ends with: name them, so it is fixed in one pass.
      more=""
      [ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" -le 5 ] || more=", ..."
      hint=" (ambiguous: $(printf '%s\n' "$matches" | head -n 5 | tr '\n' ',' | sed 's/,$//; s/,/, /g')$more)"
    fi
    unresolved_list="$unresolved_list
  $source: $citation$hint"
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

if [ "$expand" = "yes" ] && [ -s "$tmp.expand" ]; then
  sort -u "$tmp.expand" -o "$tmp.expand"
  for f in "$@"; do
    # Replace the short form only where it stands alone, not inside a longer path.
    awk -F'\t' -v file="$f" '
      FNR == NR { short[++n] = $1; full[n] = $2; next }
      {
        line = $0
        for (i = 1; i <= n; i++) {
          out = ""; rest = line
          while ((p = index(rest, short[i])) > 0) {
            before = (p > 1) ? substr(rest, p - 1, 1) : ""
            after = substr(rest, p + length(short[i]), 1)
            if (before ~ /[A-Za-z0-9_.\/-]/ || after ~ /[0-9-]/) { out = out substr(rest, 1, p + length(short[i]) - 1) }
            else { out = out substr(rest, 1, p - 1) full[i] }
            rest = substr(rest, p + length(short[i]))
          }
          line = out rest
        }
        print line
      }' "$tmp.expand" "$f" > "$f.expanded" && mv "$f.expanded" "$f"
  done
  echo "expanded to full paths: $(cut -f1 "$tmp.expand" | tr '\n' ' ')"
fi
rm -f "$tmp.expand"

echo "citations checked: $checked, invalid: $invalid, not resolvable to a file: $unresolved"
if [ "$invalid" -gt 0 ]; then
  echo "invalid citations (line numbers must be lines of the file at the PR head, not positions in diff.patch):$report"
fi
if [ "$unresolved" -gt 0 ]; then
  if [ "$strict" = "yes" ]; then
    echo "not resolvable to one file (write each as its full path from the repository root):$unresolved_list"
  else
    echo "not resolvable (not checked):$unresolved_list"
  fi
fi

[ "$invalid" -eq 0 ] || exit 1
[ "$strict" = "no" ] || [ "$unresolved" -eq 0 ]
