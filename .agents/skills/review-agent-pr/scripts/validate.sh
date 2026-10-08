#!/usr/bin/env bash
# Check an exchanged file against its contract (references/contracts.md) before the next
# step uses it. A failure means: send the file back to the subagent (or step) that wrote
# it, with this script's output, and run the check again. Never fix the file yourself.
#
# Usage: validate.sh <run-dir> <stage>
#   manifest     RUN_DIR/manifest.md, written by the orchestrator
#   reviewers    RUN_DIR/findings/*.md, written by the reviewers (runs check-outputs.sh)
#   verified     RUN_DIR/verified.md, written by the verifier (also checks its citations)
#   root-cause   RUN_DIR/root-cause.md, written by the root-cause analyst
#
# Prints "ok" or one line per problem; exits 1 on any problem.

set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -d "$1" ]; then
  echo "usage: $(basename "$0") <run-dir> <manifest|reviewers|verified|root-cause>" >&2
  exit 2
fi

run="$(cd "$1" && pwd)"
stage="$2"
here="$(cd "$(dirname "$0")" && pwd)"
problems=""
problem() { problems="$problems
$1"; }

finish() {
  if [ -n "$problems" ]; then
    printf '%s\n' "$problems" | sed '/^$/d'
    exit 1
  fi
  echo "ok"
}

# Body of the "## <title>" section of a file, ignoring headings inside code fences.
h2() {
  awk -v want="## $2" '
    /^[ ]*```/ { fence = !fence }
    !fence && /^## / { on = ($0 == want); next }
    on
  ' "$1"
}

# The tracked failure classes: from the manifest's section 8 if it lists them, otherwise
# the default list.
tracked_classes() {
  local listed
  # Names in backticks anywhere, a table's first column, or a list item's first word.
  listed="$(awk '/^## 8\./ { on = 1; next } on && /^## / { exit } on' "$run/manifest.md" 2>/dev/null | awk '
    { line = $0
      while (match(line, /`[a-z][a-z-]*`/)) { print substr(line, RSTART + 1, RLENGTH - 2); line = substr(line, RSTART + RLENGTH) } }
    /^\|/ { split($0, c, "|"); x = c[2]; gsub(/[ \t`*]/, "", x); if (x ~ /^[a-z][a-z-]*$/) print x }
    /^[ ]*[-*] / { x = $0; sub(/^[ ]*[-*] +/, "", x); gsub(/[`*]/, "", x); sub(/[ :,(].*/, "", x); if (x ~ /^[a-z][a-z-]*$/) print x }
  ' | sort -u || true)"
  if [ -n "$listed" ]; then
    printf '%s\n' "$listed"
  else
    grep -oE '^\| `[a-z][a-z-]*`' "$here/../references/failure-classes.md" | grep -oE '[a-z][a-z-]*' | sort -u
  fi
  echo "other"
  echo "spec-moved"
}

case "$stage" in
  manifest)
    f="$run/manifest.md"
    [ -s "$f" ] || { echo "manifest.md is missing or empty"; exit 1; }
    for k in 1 2 3 4 5 6 7 8; do
      grep -qE "^## ${k}\. " "$f" || problem "manifest.md: no section headed '## ${k}. ...'"
    done
    finish
    ;;

  reviewers)
    "$here/check-outputs.sh" "$run"
    ;;

  verified)
    f="$run/verified.md"
    [ -s "$f" ] || { echo "verified.md is missing or empty"; exit 1; }
    for s in "Summary" "Confirmed findings" "Minor findings table" "Rejected findings" "Spot checks" "Previous findings" "Convergence" "Verification summary" "Reviewer tables"; do
      grep -qxF "## $s" "$f" || problem "verified.md: missing section '## $s'"
    done
    rereview=no
    [ -s "$run/changed-lines.txt" ] && rereview=yes
    # Each confirmed finding: the fields the report and the fixing agent depend on.
    h2 "$f" "Confirmed findings" | awk -v rereview="$rereview" '
      function check() {
        if (id == "") return
        if (sev !~ /^(blocker|major|minor|nit)$/) print id ": Severity missing or not one of blocker, major, minor, nit (got \"" sev "\")"
        if (act !~ /^(fix now|needs owner decision|for the owner|noticed)$/) print id ": Action missing or not one of fix now, needs owner decision, for the owner, noticed (got \"" act "\")"
        if (!loc) print id ": no Location field"
        if (rereview == "yes" && chg !~ /^(yes|no)/) print id ": re-review, but no Changed since the last review field (yes or no)"
        if (act == "needs owner decision") {
          if (!dn) print id ": needs owner decision, but no Decision needed field"
          if (opts < 2) print id ": needs owner decision, but fewer than two options (a), (b)"
          if (!rec) print id ": needs owner decision, but no Recommendation field"
          if (defer && sev == "blocker") print id ": a blocker cannot be deferred to another issue"
          if (defer && opts < 2) print id ": a Defer option cannot be the only option"
        } else if (act != "") {
          if (!fix) print id ": no Suggested fix field"
          if (!done) print id ": no Done when field"
        }
        if (moved && act != "needs owner decision") print id ": Spec moved, so the action must be needs owner decision"
        if (defer && act != "needs owner decision") print id ": a Defer option needs the action needs owner decision"
      }
      /^[ ]*```/ { fence = !fence }
      !fence && /^### / {
        check()
        id = $2; sub(/:$/, "", id)
        sev = ""; act = ""; chg = ""; loc = 0; dn = 0; opts = 0; rec = 0; fix = 0; done = 0; moved = 0; defer = 0
        next
      }
      /^- \*\*Severity:\*\* / { sev = $0; sub(/^- \*\*Severity:\*\* */, "", sev); sub(/[ (].*/, "", sev) }
      /^- \*\*Action:\*\* / { act = $0; sub(/^- \*\*Action:\*\* */, "", act); gsub(/`/, "", act); sub(/[ ]*[(—-].*$/, "", act); sub(/[ ]+$/, "", act) }
      /^- \*\*Changed since the last review:\*\* / { chg = $0; sub(/^- \*\*Changed since the last review:\*\* */, "", chg) }
      /^- \*\*Location:\*\*/ { loc = 1 }
      /^- \*\*Decision needed:\*\*/ { dn = 1 }
      /^[ ]*- \([a-z]\) / { opts++; if ($0 ~ /^[ ]*- \([a-z]\) Defer to #[0-9]+/) defer = 1 }
      /^- \*\*Spec moved:\*\*/ { moved = 1 }
      /^- \*\*Recommendation:\*\*/ { rec = 1 }
      /^- \*\*Suggested fix:\*\*/ { fix = 1 }
      /^- \*\*Done when:\*\*/ { done = 1 }
      END { check() }
    ' > "$run/.validate-findings" || true
    while IFS= read -r line; do [ -n "$line" ] && problem "verified.md: $line"; done < "$run/.validate-findings"
    rm -f "$run/.validate-findings"
    # Minor table: a valid Action cell in every row.
    h2 "$f" "Minor findings table" | awk -F'|' '
      { gsub(/\\\|/, "\034") }
      /^\|/ { n++; if (n <= 2) next
        id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id)
        if (id == "" || id ~ /^None\.?$/) next   # "None." written as a row rather than a line
        a = $4; gsub(/`/, "", a); gsub(/^[ \t]+|[ \t]+$/, "", a)
        if (a !~ /^(fix now|for the owner|noticed)$/) print "minor table row \"" $2 "\": Action must be fix now, for the owner or noticed (got \"" a "\")"
      }' > "$run/.validate-minor" || true
    while IFS= read -r line; do [ -n "$line" ] && problem "verified.md: $line"; done < "$run/.validate-minor"
    rm -f "$run/.validate-minor"
    # Citations: every one must resolve to a line of a file at the PR head.
    if [ -d "$run/worktree" ]; then
      if ! out="$("$here/check-citations.sh" --strict "$run" "$f" 2>&1)"; then
        problem "verified.md: $(printf '%s' "$out" | tr '\n' ' ')"
      fi
    fi
    finish
    ;;

  root-cause)
    f="$run/root-cause.md"
    [ -s "$f" ] || { echo "root-cause.md is missing or empty"; exit 1; }
    for s in "Cause analysis" "Cause summary" "Patterns" "Proposals" "Not explained"; do
      grep -qxF "## $s" "$f" || problem "root-cause.md: missing section '## $s'"
    done
    classes="$(tracked_classes | tr '\n' ' ')"
    h2 "$f" "Cause summary" | awk -F'|' -v classes=" $classes " '
      { gsub(/\\\|/, "\034") }
      /^\|/ { n++; if (n <= 2) next
        sev = $3; gsub(/[ \t`]/, "", sev); cls = $4; gsub(/[ \t`]/, "", cls)
        if (sev !~ /^(blocker|major|minor)$/) print "cause summary row \"" $2 "\": Severity must be blocker, major or minor (got \"" sev "\")"
        if (index(classes, " " cls " ") == 0) print "cause summary row \"" $2 "\": failure class \"" cls "\" is not in the tracked list"
      }' > "$run/.validate-rc" || true
    while IFS= read -r line; do [ -n "$line" ] && problem "root-cause.md: $line"; done < "$run/.validate-rc"
    rm -f "$run/.validate-rc"
    finish
    ;;

  *)
    echo "error: unknown stage '$stage'" >&2
    exit 2
    ;;
esac
