#!/usr/bin/env bash
# Assemble the review's two outputs from the phase outputs in a run directory.
#
# Usage:
#   assemble-report.sh <run-dir> report <head-sha>
#       Reads  report-head.md, report-meta.md, verified.md, findings/*.md
#       Writes report.md: the PR comment (code findings and evidence).
#
#   assemble-report.sh <run-dir> process <pr-number> <head-sha>
#       Reads  root-cause.md
#       Writes process.md: the tracking-issue comment (causes and proposals).
#
# In report mode the full check tables are included only when the comment stays within the
# soft limit. Exits 1, with the size of each section, when an output cannot be made to fit.

set -euo pipefail

SOFT_LIMIT=60000

usage() {
  echo "usage: $(basename "$0") <run-dir> report <head-sha>" >&2
  echo "       $(basename "$0") <run-dir> process <pr-number> <head-sha>" >&2
  exit 2
}

[ "$#" -ge 2 ] && [ -d "$1" ] || usage
run="$(cd "$1" && pwd)"
mode="$2"
verified="$run/verified.md"
rootcause="$run/root-cause.md"

missing=""
need() {
  local file="$1" heading
  shift
  for heading in "$@"; do
    grep -qxF "## $heading" "$file" || missing="$missing
  $(basename "$file"): ## $heading"
  done
}
fail_if_missing() {
  if [ -n "$missing" ]; then
    echo "error: required sections are missing:$missing" >&2
    exit 1
  fi
}

# Body of the "## <title>" section of a file. Headings inside code fences are ignored.
h2() {
  awk -v want="## $2" '
    /^[ ]*```/ { fence = !fence }
    !fence && /^## / { on = ($0 == want); next }
    on
  ' "$1"
}

# Body of the first "### <prefix>..." section of a file.
h3() {
  awk -v want="### $2" '
    /^[ ]*```/ { fence = !fence }
    !fence && /^##+ / { on = (/^### / && index($0, want) == 1); next }
    on
  ' "$1"
}

# Drop leading and trailing blank lines.
trim() {
  awk 'NF { seen = 1 } seen { buf[++n] = $0 } END { while (n > 0 && buf[n] !~ /[^ \t]/) n--; for (i = 1; i <= n; i++) print buf[i] }'
}

# Number of data rows in the markdown tables on stdin.
rows() {
  awk '/^\|/ { n++; if ($0 ~ /^\|[ :|-]+\|?$/) n -= 2 } END { print (n > 0 ? n : 0) }'
}

# Number of top-level list items on stdin.
items() {
  awk '/^- / { n++ } END { print n + 0 }'
}

or_default() {
  local text
  text="$(cat)"
  if [ -n "$text" ]; then printf '%s\n' "$text"; else printf '%s\n' "$1"; fi
}

size() {
  LC_ALL=en_US.UTF-8 wc -m < "$1" | tr -d '[:space:]'
}

too_long() {
  local file="$1" chars="$2"
  {
    echo "error: $(basename "$file") is $chars characters; the limit is $SOFT_LIMIT."
    echo "Section sizes (characters):"
    awk '
      /^### / { if (name != "") printf "  %6d  %s\n", n, name; name = $0; n = 0 }
      { n += length($0) + 1 }
      END { if (name != "") printf "  %6d  %s\n", n, name }
    ' "$file"
    echo "Shorten the largest section in its source file and run this again."
  } >&2
  exit 1
}

# Confirmed findings with the given action, as report blocks: blockers and majors only, or
# every severity when the second argument is "all". Findings that need the owner's decision
# end with the line the owner can reply with.
top_findings() {
  h2 "$verified" "Confirmed findings" | awk -v want="$1" -v all="${2:-}" -v sha="${report_sha:0:7}" '
    function flush() {
      if (sev && act) {
        printf "%s", block
        if (want == "needs owner decision" && id != "")
          printf "\n**To decide, reply on this PR:** `Decision %s/%s: %s`\n\n", sha, id, (rec != "" ? rec : "<your answer>")
      }
      block = ""; sev = 0; act = 0; id = ""; rec = ""
    }
    /^[ ]*```/ { fence = !fence }
    !fence && /^### / { flush(); sub(/^### /, "#### "); id = $2; sub(/:$/, "", id) }
    /^- \*\*Severity:\*\* / && (all == "all" || /\*\* (blocker|major)/) { sev = 1 }
    /^- \*\*Recommendation:\*\* \([a-z]\)/ { rec = $3; sub(/,$/, "", rec) }
    /^- \*\*Action:\*\* / { line = $0; gsub(/`/, "", line); if (index(line, "- **Action:** " want) == 1) act = 1; next }
    /^- \*\*(Checked by verifier|Introduced by this PR|Merged|Category|Fixable within the PR.s scope):\*\*/ { next }
    { block = block $0 "\n" }
    END { flush() }
  '
}

# Rows of the minor findings table with the given action, without the Action column.
minor_rows() {
  h2 "$verified" "Minor findings table" | awk -v want="$1" '
    /^\|/ {
      if (!match($0, /^\|[^|]*\|[^|]*\|/)) next
      keep = substr($0, 1, RLENGTH)
      rest = substr($0, RLENGTH + 1)
      cell = rest
      sub(/\|.*/, "", cell)
      sub(/^[^|]*\|/, "", rest)
      gsub(/`/, "", cell); gsub(/^[ \t]+|[ \t]+$/, "", cell)
      n++
      if (n <= 2) { head[n] = keep rest; next }
      if (cell == want) { if (!printed) { print head[1]; print head[2]; printed = 1 } print keep rest }
    }
  '
}

# One group of the report: full blocks for blockers and majors, a table for the rest. Every
# finding that needs the owner's decision is shown in full, whatever its severity.
group() {
  local action="$1" blocks minors
  if [ "$action" = "needs owner decision" ]; then
    blocks="$(top_findings "$action" all | trim)"
    minors=""
  else
    blocks="$(top_findings "$action" | trim)"
    minors="$(minor_rows "$action")"
  fi
  if [ -z "$blocks" ] && [ -z "$minors" ]; then
    echo "None."
    return
  fi
  if [ -n "$blocks" ]; then
    printf '%s\n' "$blocks"
  fi
  if [ -n "$minors" ]; then
    [ -z "$blocks" ] || printf '\n**Minor findings and nits**\n\n'
    printf '%s\n' "$minors"
  fi
}

reviewers="standards code-smells spec-alignment test-adequacy"

label() {
  case "$1" in
    standards) echo "Standards" ;;
    code-smells) echo "Code smells" ;;
    spec-alignment) echo "Spec alignment" ;;
    test-adequacy) echo "Test adequacy" ;;
  esac
}

build_report() {
  local with_tables="$1" r f

  echo "<!-- agent-pr-review:report sha=$report_sha -->"
  trim < "$run/report-head.md"

  printf '\n### Fix now\n\n'
  echo "For the agent that wrote this PR: fix these. Nothing here needs a product decision."
  echo
  group "fix now"

  printf '\n### Needs the owner'"'"'s decision\n\n'
  echo 'Do not act on these until the owner has answered. Owner: reply on this PR with one line per decision, in the form shown under each finding (`Decision <commit>/<ID>: <answer>`), giving the letter of an option or your own answer after the colon. The fixing agent reads these lines.'
  echo
  group "needs owner decision"

  printf '\n### For the owner (no action in this PR)\n\n'
  echo "Real gaps this PR exposes but could not fix within its allowed scope. They do not count toward the verdict."
  echo
  group "for the owner"

  local previous
  previous="$(h2 "$verified" "Previous findings" | trim)"
  case "$previous" in
    "" | "No previous review."*) ;;
    *)
      printf '\n### Previous findings\n\n'
      echo "What became of each finding from the previous review, checked against this commit."
      echo
      printf '%s\n' "$previous"
      ;;
  esac

  printf '\n### Spec alignment\n\n'
  h3 "$verified" "Spec traceability" | trim | or_default "Not reviewable: no spec found."
  printf '\n**Unrequested changes**\n\n'
  h3 "$verified" "Unrequested changes" | trim | or_default "None."

  printf '\n### Evidence of review\n\n'
  echo "| Reviewer | Checks recorded | Searches run | Items not reviewed |"
  echo "|---|---|---|---|"
  for r in $reviewers; do
    f="$run/findings/$r.md"
    if [ -s "$f" ]; then
      checks=$(($(h3 "$f" "Checks performed" | rows) + $(h3 "$f" "Behaviour coverage" | rows) + $(h3 "$f" "Spec traceability" | rows)))
      echo "| $(label "$r") | $checks | $(h3 "$f" "Searches run" | rows) | $(h2 "$f" "3. Not reviewed" | items) |"
    else
      echo "| $(label "$r") | did not run | | |"
    fi
  done

  printf '\n<details>\n<summary>Not reviewed</summary>\n\n'
  for r in $reviewers; do
    f="$run/findings/$r.md"
    [ -s "$f" ] || continue
    printf '**%s**\n\n' "$(label "$r")"
    h2 "$f" "3. Not reviewed" | trim | or_default "Nothing skipped."
    echo
  done
  printf '</details>\n'

  printf '\n<details>\n<summary>Findings rejected or merged in verification</summary>\n\n'
  h2 "$verified" "Rejected findings" | trim | or_default "None."
  printf '\n**Verification summary**\n\n'
  h2 "$verified" "Verification summary" | trim
  printf '\n</details>\n'

  local spot spot_count
  spot="$(h2 "$verified" "Spot checks" | trim)"
  spot_count="$(printf '%s\n' "$spot" | rows)"
  printf '\n<details>\n<summary>Passed checks re-checked by the verifier (%s)</summary>\n\n' "$spot_count"
  printf '%s\n' "$spot" | or_default "None."
  printf '\n</details>\n'

  if [ "$with_tables" = "yes" ]; then
    printf '\n<details>\n<summary>Every check performed</summary>\n\n'
    for r in $reviewers; do
      f="$run/findings/$r.md"
      [ -s "$f" ] || continue
      printf '**%s**\n\n' "$(label "$r")"
      h3 "$f" "Checks performed" | trim
      echo
    done
    printf '**Behaviour coverage**\n\n'
    h3 "$verified" "Behaviour coverage" | trim | or_default "Not produced."
    printf '\n</details>\n'
  fi

  printf '\n<details>\n<summary>Run metadata</summary>\n\n'
  trim < "$run/report-meta.md"
  if [ "$with_tables" = "yes" ]; then
    echo "- Full check tables: included above."
  else
    echo "- Full check tables: left out to fit one comment; they are in the run directory (\`findings/*.md\`, \`verified.md\`)."
  fi
  printf '\n</details>\n'
}

build_process() {
  local pr="$1" sha="$2"

  echo "<!-- agent-pr-review:process pr=$pr sha=$sha -->"
  echo "## Review of PR #$pr at \`$sha\`"
  echo
  echo "Why the agent produced the findings of that review, and what could change in the project's docs, skills, prompts, specs and guardrails. Causes are inferences from the repository: the agent's prompt and transcript were not available."

  printf '\n### Causes\n\n'
  h2 "$rootcause" "Cause summary" | trim
  printf '\n**Patterns**\n\n'
  h2 "$rootcause" "Patterns" | trim | or_default "None."
  printf '\n**Not explained**\n\n'
  h2 "$rootcause" "Not explained" | trim | or_default "Nothing."

  printf '\n### Proposals\n\n'
  h2 "$rootcause" "Proposals" | awk '
    /^[ ]*```/ { fence = !fence }
    !fence && /^### / { sub(/^### /, "#### ") }
    { print }
  ' | trim | or_default "None."
}

case "$mode" in
  report)
    [ "$#" -eq 3 ] || usage
    report_sha="$3"
    printf '%s' "$report_sha" | grep -qE '^[0-9a-f]{40}$' || { echo "error: give the full 40-character reviewed commit, got '$report_sha'" >&2; exit 2; }
    for required in "$run/report-head.md" "$run/report-meta.md" "$verified"; do
      [ -s "$required" ] || { echo "error: missing or empty $required" >&2; exit 1; }
    done
    need "$verified" "Confirmed findings" "Minor findings table" "Rejected findings" "Spot checks" "Previous findings" "Verification summary" "Reviewer tables"
    fail_if_missing
    confirmed="$(h2 "$verified" "Confirmed findings")"
    case "$confirmed" in
      *"
### "* | "### "*)
        case "$confirmed" in
          *"
- **Action:** "*) ;;
          *)
            echo "error: confirmed findings in verified.md have no 'Action' field" >&2
            exit 1
            ;;
        esac
        ;;
    esac

    out="$run/report.md"
    build_report yes > "$out"
    tables="included"
    if [ "$(size "$out")" -gt "$SOFT_LIMIT" ]; then
      build_report no > "$out"
      tables="left out"
    fi
    chars="$(size "$out")"
    [ "$chars" -le "$SOFT_LIMIT" ] || too_long "$out" "$chars"
    echo "wrote $out ($chars characters; check tables $tables)"
    ;;

  process)
    [ "$#" -eq 4 ] || usage
    case "$3" in '' | *[!0-9]*) echo "error: PR number must be numeric, got '$3'" >&2; exit 2 ;; esac
    case "$4" in '' | *[!0-9a-f]*) echo "error: head sha must be hexadecimal, got '$4'" >&2; exit 2 ;; esac
    [ -s "$rootcause" ] || { echo "error: missing or empty $rootcause" >&2; exit 1; }
    need "$rootcause" "Cause summary" "Patterns" "Proposals" "Not explained"
    fail_if_missing

    out="$run/process.md"
    build_process "$3" "$4" > "$out"
    chars="$(size "$out")"
    [ "$chars" -le "$SOFT_LIMIT" ] || too_long "$out" "$chars"
    echo "wrote $out ($chars characters)"
    ;;

  *)
    usage
    ;;
esac
