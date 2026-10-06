#!/usr/bin/env bash
# Check an exchanged file of a readiness review against its contract
# (references/contracts.md). A failure means: send the file back to whoever wrote it, with
# this script's output, and run the check again. Never fix it yourself.
#
# Usage: validate.sh <run-dir> <stage>
#   manifest    RUN_DIR/manifest.md (orchestrator)
#   analysis    RUN_DIR/analysis/spec.md and code.md (the analysts)
#   readiness   RUN_DIR/readiness.md (the verifier or the refresh analyst)
#
# Prints "ok" or one line per problem; exits 1 on any problem.

set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -d "$1" ]; then
  echo "usage: $(basename "$0") <run-dir> <manifest|analysis|readiness>" >&2
  exit 2
fi

run="$(cd "$1" && pwd)"
stage="$2"
problems=""
problem() { problems="$problems
$1"; }
finish() {
  if [ -n "$problems" ]; then printf '%s\n' "$problems" | sed '/^$/d'; exit 1; fi
  echo "ok"
}
need() {
  local file="$1"; shift
  local h
  for h in "$@"; do grep -qxF "$h" "$file" || problem "$(basename "$file"): missing '$h'"; done
}

case "$stage" in
  manifest)
    f="$run/manifest.md"
    [ -s "$f" ] || { echo "manifest.md is missing or empty"; exit 1; }
    for k in 1 2 3 4 5 6; do
      grep -qE "^## ${k}\. " "$f" || problem "manifest.md: no section headed '## ${k}. ...'"
    done
    grep -qE '[0-9a-f]{40}' "$f" || problem "manifest.md: no full spec commit (the default branch's commit)"
    finish
    ;;

  analysis)
    for f in spec code; do
      [ -s "$run/analysis/$f.md" ] || problem "analysis/$f.md is missing or empty"
    done
    [ -s "$run/analysis/spec.md" ] && need "$run/analysis/spec.md" "## Requirements" "## Open behaviour" "## Conflicts" "## Stale references" "## Scope" "## Not checked"
    [ -s "$run/analysis/code.md" ] && need "$run/analysis/code.md" "## Map" "## Owned paths" "## Reuse" "## Lines made stale" "## Searches run" "## Dependencies and overlaps" "## Sibling issues" "## Size" "## Risks" "## Not checked"
    finish
    ;;

  readiness)
    f="$run/readiness.md"
    [ -s "$f" ] || { echo "readiness.md is missing or empty"; exit 1; }
    head -n 1 "$f" | grep -qE '^<!-- agent-pr-review:readiness round=[0-9]+ -->$' || problem "readiness.md: first line must be <!-- agent-pr-review:readiness round=<k> -->"
    k="$(head -n 1 "$f" | sed -n 's/.*round=\([0-9]*\).*/\1/p')"
    grep -qE '^## Readiness (review|refresh) \(round [0-9]+\): (Ready|Ready with assumptions|Needs answers|Not ready|Still ready)$' "$f" || problem "readiness.md: heading must be '## Readiness review (round <k>): <verdict>' with a verdict from the format"
    grep -qE '^Round: [0-9]+ · .*Spec commit: [0-9a-f]{40}' "$f" || problem "readiness.md: data line must include 'Spec commit: <full sha>'"
    grep -q '^\*\*Relied on:\*\*' "$f" || problem "readiness.md: no 'Relied on:' list"
    grep -q '^\*\*Check these first:\*\*' "$f" || problem "readiness.md: no 'Check these first:' line (the riskiest assumptions, or 'none')"
    awk -v k="$k" '
      /^#### Q-[0-9]+:/ { if (q != "") check(); q = $2; sub(/:$/, "", q); opts = 0; rec = 0; reply = 0; next }
      /^#{2,4} / { if (q != "") check(); q = "" }
      q != "" && /^[ ]+- \([a-z]\) / { opts++; if ($0 !~ /Scope: /) print q ": option without a Scope label" }
      q != "" && /^- \*\*Recommendation:\*\* \([a-z]\)/ { rec = 1 }
      q != "" && /^- \*\*Reply:\*\* `Decision r[0-9]+\/Q-[0-9]+: / { reply = 1 }
      function check() {
        if (opts < 2) print q ": fewer than two options"
        if (!rec) print q ": no Recommendation naming an option"
        if (!reply) print q ": no Reply line (`Decision r" k "/" q ": ...`)"
      }
      END { if (q != "") check() }
    ' "$f" > "$run/.validate-q" || true
    while IFS= read -r l; do [ -n "$l" ] && problem "readiness.md: $l"; done < "$run/.validate-q"
    rm -f "$run/.validate-q"
    # Assumption rows: an ID, a basis, a Makes stale cell.
    awk -F'|' '/^\| A-[0-9]+ \|/ { if (NF < 7) print $2 ": assumption row needs ID, Assumption, Basis, Makes stale and To correct" }' "$f" > "$run/.validate-a" || true
    while IFS= read -r l; do [ -n "$l" ] && problem "readiness.md: $l"; done < "$run/.validate-a"
    rm -f "$run/.validate-a"
    # "Like X" pointers are not allowed: reuse says import, move and share, or ask.
    # Quoted issue text (inside ``` blocks) is not checked.
    awk '/^```/ { inb = !inb; next } !inb && (/[Ll]ike `[^`]+`/ || /(the way|same as|as) `[^`]+` (does|did)/) { print NR }' "$f" > "$run/.validate-like" || true
    while IFS= read -r l; do [ -n "$l" ] && problem "readiness.md: line $l points to code by likeness; say import it, move and share it, or ask"; done < "$run/.validate-like"
    rm -f "$run/.validate-like"
    # Each question's options one per line, never two on one line.
    awk '/^```/ { inb = !inb; next } !inb && /^[ ]+- \([a-z]\) .*[;,] \([b-z]\) / { print NR }' "$f" > "$run/.validate-opt" || true
    while IFS= read -r l; do [ -n "$l" ] && problem "readiness.md: line $l holds more than one option; write one option per line"; done < "$run/.validate-opt"
    rm -f "$run/.validate-opt"
    # Each edit's Before text must be in the description as it is now.
    if [ -f "$run/issue-body.md" ]; then
      awk '
        /^#### E-[0-9]+:/ { e = $2; sub(/:$/, "", e); part = ""; next }
        /^#{2,4} / { e = "" }
        e != "" && /^Before:/ { part = "b"; next }
        e != "" && /^After:/ { part = "" ; next }
        e != "" && part == "b" && /^```/ { inb = !inb; if (!inb) { print "EDIT\t" e; part = "" } ; next }
        e != "" && part == "b" && inb { print "LINE\t" e "\t" $0 }
      ' "$f" > "$run/.validate-e"
      awk -F'\t' -v bodyfile="$run/issue-body.md" '
        BEGIN { while ((getline l < bodyfile) > 0) body = body (nb++ ? "\n" : "") l }
        $1 == "LINE" { t[$2] = t[$2] (has[$2]++ ? "\n" : "") substr($0, length($1 "\t" $2 "\t") + 1) }
        $1 == "EDIT" { if (t[$2] != "" && index(body, t[$2]) == 0) print $2 ": its Before text is not in the issue description" }
      ' "$run/.validate-e" > "$run/.validate-e2" || true
      while IFS= read -r l; do [ -n "$l" ] && problem "readiness.md: $l"; done < "$run/.validate-e2"
      rm -f "$run/.validate-e" "$run/.validate-e2"
    fi
    finish
    ;;

  *)
    echo "error: unknown stage '$stage'" >&2
    exit 2
    ;;
esac
