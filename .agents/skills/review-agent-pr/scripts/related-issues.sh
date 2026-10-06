#!/usr/bin/env bash
# List the open issues related to a PR, as facts for the verifier: issues whose description
# names a file the PR changes (or a directory holding one), and issues linked from the PR's
# own issues. For each, its acceptance criteria, owned paths and "Decisions and
# clarifications" sections, quoted.
#
# Usage: related-issues.sh <run-dir> [<own issue>...]
#
# Reads <run-dir>/files.json (from get-pr.sh) and <run-dir>/spec/issue-*.md (from
# get-issue.sh). The PR's own issues (the arguments, and the issue files' numbers when no
# argument is given) are left out. Writes <run-dir>/related-issues.md and prints how many
# issues it lists. At most 15 issues, those naming the most changed files first.
# Uses the REST API only. Run from inside a clone of the repository.

set -euo pipefail

if [ "$#" -lt 1 ] || [ ! -f "$1/files.json" ]; then
  echo "usage: $(basename "$0") <run-dir> [<own issue>...]  (the run directory must hold files.json)" >&2
  exit 2
fi

run="$(cd "$1" && pwd)"
shift
out="$run/related-issues.md"
max=15

own=" $* "
if [ "$#" -eq 0 ]; then
  for f in "$run"/spec/issue-*.md; do
    [ -f "$f" ] || continue
    m="$(basename "$f" .md)"; own="$own${m#issue-} "
  done
fi

changed="$(grep -oE '"filename":"[^"]*"' "$run/files.json" | sed 's/^"filename":"//; s/"$//' | sort -u)"

# Issues the PR's own issues link to.
linked=""
for f in "$run"/spec/issue-*.md; do
  [ -f "$f" ] || continue
  from="$(basename "$f" .md)"; from="${from#issue-}"
  for m in $(grep -oE '(^|[^&A-Za-z0-9])#[0-9]+' "$f" | grep -oE '[0-9]+' | sort -u); do
    case "$own" in *" $m "*) continue ;; esac
    linked="$linked
$m	$from"
  done
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh api --paginate "repos/{owner}/{repo}/issues?state=open&per_page=100" \
  --jq '.[] | select(.pull_request | not) | "\(.number)\t\(.html_url)\t\(.title | gsub("\t"; " "))\t\((.body // "") | @base64)"' \
  > "$tmp/issues.tsv"

: > "$tmp/hits.tsv"
while IFS="$(printf '\t')" read -r num url title body64; do
  case "$own" in *" $num "*) continue ;; esac
  printf '%s' "$body64" | base64 --decode > "$tmp/body-$num.md" 2>/dev/null || : > "$tmp/body-$num.md"
  printf '%s\t%s\n' "$url" "$title" > "$tmp/meta-$num"
  # Path-like words in the description: in backticks, or bare words with a slash or a dot extension.
  grep -oE '`[^`]+`|[A-Za-z0-9_.-]+(/[A-Za-z0-9_.*-]+)+/?' "$tmp/body-$num.md" | tr -d '`' | sed 's|^\./||' | sort -u > "$tmp/tokens-$num" || true
  hits=""
  count=0
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if grep -qxF "$file" "$tmp/tokens-$num" || awk -v f="$file" '{ t = $0; sub(/\*+$/, "", t); if (t != "" && t ~ /\/$/ && index(f, t) == 1) found = 1 } END { exit !found }' "$tmp/tokens-$num"; then
      hits="$hits, \`$file\`"; count=$((count + 1))
    fi
  done <<< "$changed"
  via="$(printf '%s\n' "$linked" | awk -F'\t' -v n="$num" '$1 == n { printf "%s#%s", (s++ ? ", " : ""), $2 }')"
  if [ "$count" -gt 0 ] || [ -n "$via" ]; then
    reason=""
    [ "$count" -gt 0 ] && reason="names files this PR changes: ${hits#, }"
    [ -n "$via" ] && reason="${reason:+$reason; }linked from $via"
    printf '%s\t%s\t%s\n' "$count" "$num" "$reason" >> "$tmp/hits.tsv"
  fi
done < "$tmp/issues.tsv"

section() {
  awk -v pat="$2" '
    /^#+ / { on = (tolower($0) ~ pat); if (on) { found = 1; next } }
    on { print }
    END { if (!found) print "(no such section)" }
  ' "$1" | awk 'NF { seen = 1 } seen'
}

n_listed=0
{
  echo "# Related open issues"
  echo
  echo "Facts for the verifier: open issues that name files this PR changes, or that the PR's"
  echo "issues link to. Listed by how many changed files they name; at most $max."
  sort -t "$(printf '\t')" -k1,1nr -k2,2n "$tmp/hits.tsv" | head -n "$max" |
  while IFS="$(printf '\t')" read -r count num reason; do
    IFS="$(printf '\t')" read -r url title < "$tmp/meta-$num"
    echo
    echo "## #$num: $title"
    echo
    echo "$url · Related: $reason"
    for s in "Acceptance criteria:acceptance" "Owned paths:owned path" "Decisions and clarifications:decisions and clarifications"; do
      echo
      echo "### ${s%%:*}"
      echo
      section "$tmp/body-$num.md" "${s#*:}"
    done
  done
} > "$out"

n_listed="$(grep -c '^## #' "$out" || true)"
[ "$n_listed" -gt 0 ] || printf '\nNone found.\n' >> "$out"
echo "related open issues: $n_listed ($out)"
