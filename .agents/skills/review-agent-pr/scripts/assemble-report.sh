#!/usr/bin/env bash
# Assemble the review's two outputs from the phase outputs in a run directory.
#
# Usage:
#   assemble-report.sh <run-dir> report <head-sha>
#       Reads  report-head.md, report-meta.md, verified.md, findings/*.md
#       Writes report-01.md, report-02.md, ...: the PR comments to post, in order, and
#       findings.json (one JSON object per confirmed finding, for counting). A report
#       that fits in one comment is one part; a longer one is split between sections or
#       findings into consecutive comments, each marked "part k/n". Also writes report.md,
#       the whole report in one file, for the run's records (not posted).
#
#   assemble-report.sh <run-dir> process <pr-number> <head-sha>
#       Reads  root-cause.md
#       Writes process.md: the tracking-issue comment (causes and proposals).
#
# The process output must fit in one comment; the script exits 1, with the size of each
# section, when it does not.

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

# A reviewer's output files: findings/<name>.md, or findings/<name>--<part>.md when a large
# PR was split into parts.
outputs() {
  local f
  for f in "$run/findings/$1.md" "$run/findings/$1--"*.md; do
    [ -s "$f" ] && printf '%s\n' "$f"
  done
  return 0
}

# Sum of a counter over all of a reviewer's output files.
total() {
  local r="$1" kind="$2" f n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$kind" in
      checks) n=$((n + $(h3 "$f" "Checks performed" | rows) + $(h3 "$f" "Behaviour coverage" | rows) + $(h3 "$f" "Spec traceability" | rows))) ;;
      searches) n=$((n + $(h3 "$f" "Searches run" | rows))) ;;
      skipped) n=$((n + $(h2 "$f" "3. Not reviewed" | items))) ;;
    esac
  done < <(outputs "$r")
  echo "$n"
}

parts_note() {
  local count
  count="$(outputs "$1" | grep -c . || true)"
  [ "$count" -gt 1 ] && printf ' (%s parts)' "$count"
  return 0
}

# ", part 2" for findings/<name>--2.md, nothing for an unsplit output.
part_label() {
  case "$(basename "$1" .md)" in
    *--*) printf ', part %s' "${1##*--}" | sed 's/\.md$//' ;;
  esac
}

label() {
  case "$1" in
    standards) echo "Standards" ;;
    code-smells) echo "Code smells" ;;
    spec-alignment) echo "Spec alignment" ;;
    test-adequacy) echo "Test adequacy" ;;
  esac
}

# The counts for the report header, computed from verified.md so nobody copies them by
# hand: confirmed findings by reviewer (from the ID prefix) and severity, by action, and
# the rejected and merged totals.
counts_block() {
  local blocks rejected merged
  blocks="$(h2 "$verified" "Confirmed findings" | awk '
    /^[ ]*```/ { fence = !fence }
    !fence && /^### / { if (id != "") print id "\t" sev "\t" act; id = $2; sub(/:$/, "", id); sev = ""; act = ""; next }
    /^- \*\*Severity:\*\* / { sev = $0; sub(/^- \*\*Severity:\*\* */, "", sev); sub(/[ (].*/, "", sev) }
    /^- \*\*Action:\*\* / { act = $0; sub(/^- \*\*Action:\*\* */, "", act); gsub(/`/, "", act); sub(/[ ]*[(—-].*$/, "", act); sub(/[ ]+$/, "", act) }
    END { if (id != "") print id "\t" sev "\t" act }')"
  rejected="$(h2 "$verified" "Rejected findings" | awk '
    /^#+ *Merged|^\*\*Merged|^Merged/ { stop = 1 }
    !stop && /^\| *[A-Z]+-[0-9]/ { n++ } END { print n + 0 }')"
  merged="$(h2 "$verified" "Rejected findings" | awk '
    /^#+ *Merged|^\*\*Merged|^Merged/ { on = 1; next }
    on && /^\| *[A-Z]+-[0-9]/ { n++ } END { print n + 0 }')"
  printf '%s\n' "$blocks" | awk -F'\t' -v rejected="$rejected" -v merged="$merged" '
    NF >= 2 {
      p = $1; sub(/-.*/, "", p)
      r = (p == "STD" ? "Standards" : p == "SMELL" ? "Code smells" : p == "SPEC" ? "Spec alignment" : p == "TEST" ? "Test adequacy" : p == "VER" ? "Verifier" : "Other")
      c[r, $2]++; seen[r] = 1; total++
      a[$3]++
    }
    END {
      printf "Confirmed findings after verification: %d (rejected %d, merged %d).\n\n", total, rejected, merged
      print "| | Blocker | Major | Minor | Nit |"
      print "|---|---|---|---|---|"
      split("Standards|Code smells|Spec alignment|Test adequacy|Verifier|Other", rows, "|")
      for (i = 1; i <= 6; i++) {
        r = rows[i]
        if (i <= 4 || seen[r]) printf "| %s | %d | %d | %d | %d |\n", r, c[r, "blocker"], c[r, "major"], c[r, "minor"], c[r, "nit"]
      }
      printf "\nBy action: %d to fix now, %d waiting for the owner'"'"'s decision, %d for the owner", a["fix now"], a["needs owner decision"], a["for the owner"]
      if (a["noticed"] > 0) printf ", %d noticed in unchanged code (not blocking)", a["noticed"]
      print "."
    }'
}

# The readiness state of the PR's issues, from spec-moves.md: "#19 round 1 (Ready, applied)",
# "none" when no issue had a readiness review, "unknown" without the file.
readiness_state() {
  [ -f "$run/spec-moves.md" ] || { echo "unknown"; return; }
  awk '
    /^## Readiness of the PR/ { on = 1; next }
    on && /^## / { exit }
    on && /^- #[0-9]+: (review|refresh) \(round [0-9]+\): / {
      n = $2; sub(/:$/, "", n)
      r = $0; sub(/^.*\(round /, "", r); sub(/\).*/, "", r)
      v = $0; sub(/^[^)]*\): /, "", v); sub(/ ·.*/, "", v)
      a = ($0 ~ /answers applied: yes/) ? ", applied" : ""
      s = s (s == "" ? "" : "; ") n " round " r " (" v a ")"
    }
    END { print (s == "" ? "none" : s) }' "$run/spec-moves.md"
}

# The cost of the run, from the cost lines the orchestrator appends to progress.txt
# ("cost=<phase>:<who>:<tokens>:<seconds>", where the runtime reports them).
cost_state() {
  grep '^cost=' "$run/progress.txt" 2>/dev/null | awk -F: '
    { n++; if ($3 ~ /^[0-9]+$/) tok += $3; else tu = 1; if ($4 ~ /^[0-9]+$/) sec += $4; else su = 1 }
    END {
      if (n == 0) { print "not reported"; exit }
      printf "%s tokens, %s min in %d subagents\n", (tu ? "≥" : "") tok, (su ? "≥" : "") int(sec / 60 + 0.5), n
    }' | grep . || echo "not reported"
}

# findings.json: one JSON object per line per confirmed finding, for improve-agent-process to
# count from without reading prose.
write_findings_json() {
  local out="$1" round version lines readiness
  readiness="$(readiness_state)"
  if [ -s "$run/previous/report.md" ]; then round="re-review"; else round="first"; fi
  version="$(sed -n 's/^  harness-version: "\(.*\)"$/\1/p' "$(dirname "$0")/../SKILL.md" | head -n 1)"
  lines="$({ grep -o '"additions":[0-9]*' "$run/pr.json" | head -n 1; grep -o '"deletions":[0-9]*' "$run/pr.json" | head -n 1; } 2>/dev/null | cut -d: -f2 | awk '{ s += $1 } END { print s + 0 }')"
  {
    h2 "$rootcause" "Cause summary" 2>/dev/null | awk -F'|' '{ gsub(/\\\|/, "\034") } /^\| *[A-Z]+-[0-9]/ {
      id = $2; gsub(/^[ \t]+|[ \t]+$/, "", id); sub(/[ (].*/, "", id)
      cls = $4; gsub(/[ \t`]/, "", cls); cause = $5; gsub(/`/, "", cause); gsub(/^[ \t]+|[ \t]+$/, "", cause); gsub(/\034/, "|", cause)
      print "CLASS\t" id "\t" cls "\t" cause }'
    h2 "$verified" "Confirmed findings" | sed 's/^/BODY\t/'
  } | awk -F'\t' -v pr="${pr_number:-}" -v sha="$report_sha" -v round="$round" -v version="$version" -v lines="${lines:-0}" -v readiness="$readiness" '
    function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, " ", s); return s }
    function emit() {
      if (id == "") return
      printf "{\"pr\":%s,\"commit\":\"%s\",\"round\":\"%s\",\"changed_lines\":%s,\"harness_version\":\"%s\",\"id\":\"%s\",\"title\":\"%s\",\"severity\":\"%s\",\"action\":\"%s\",\"changed_since_last_review\":\"%s\",\"location\":\"%s\",\"failure_class\":\"%s\",\"cause\":\"%s\",\"spec_moved\":%s,\"readiness\":\"%s\"}\n", (pr == "" ? "null" : pr), sha, round, lines, esc(version), esc(id), esc(title), sev, act, esc(chg), esc(loc), esc(cls[id]), esc(cause[id]), (moved ? "true" : "false"), esc(readiness)
    }
    $1 == "CLASS" { cls[$2] = $3; cause[$2] = $4; next }
    $1 == "BODY" {
      line = substr($0, 6)
      if (line ~ /^[ ]*```/) fence = !fence
      if (!fence && line ~ /^### /) { emit(); id = line; sub(/^### /, "", id); title = id; sub(/:.*/, "", id); sub(/^[^:]*: */, "", title); sev = ""; act = ""; chg = ""; loc = ""; moved = 0; next }
      if (line ~ /^- \*\*Spec moved:\*\*/) moved = 1
      if (line ~ /^- \*\*Severity:\*\* /) { sev = line; sub(/^- \*\*Severity:\*\* */, "", sev); sub(/[ (].*/, "", sev) }
      if (line ~ /^- \*\*Action:\*\* /) { act = line; sub(/^- \*\*Action:\*\* */, "", act); gsub(/`/, "", act); sub(/[ ]*[(—-].*$/, "", act); sub(/[ ]+$/, "", act) }
      if (line ~ /^- \*\*Changed since the last review:\*\* /) { chg = line; sub(/^- \*\*Changed since the last review:\*\* */, "", chg); sub(/[ (—].*/, "", chg) }
      if (line ~ /^- \*\*Location:\*\*/ && match(line, /`[^`]+`/)) loc = substr(line, RSTART + 1, RLENGTH - 2)
    }
    END { emit() }' > "$out"
}

build_report() {
  local r f summary

  # The summary in the header is the verifier's, inserted here so the orchestrator never
  # writes its own.
  summary="$(h2 "$verified" "Summary" | trim)"
  local counts
  counts="$(counts_block)"
  SUMMARY="$summary" COUNTS="$counts" awk '
    $0 == "<!-- summary -->" { print ENVIRON["SUMMARY"]; next }
    $0 == "<!-- counts -->" { print ENVIRON["COUNTS"]; next }
    { print }' "$run/report-head.md" | trim

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

  # Re-reviews: findings in code unchanged since the last review that do not block.
  local noticed
  noticed="$(minor_rows "noticed")"
  if [ -n "$noticed" ]; then
    printf '\n### Noticed in unchanged code (not blocking)\n\n'
    echo "Found in code this PR has not changed since the last review. Not part of this PR's work and not counted in the verdict; worth a follow-up issue if they matter."
    echo
    printf '%s\n' "$noticed"
  fi

  local convergence
  convergence="$(h2 "$verified" "Convergence" | trim)"
  case "$convergence" in
    "" | "First review."*) ;;
    *)
      printf '\n### Convergence\n\n'
      printf '%s\n' "$convergence"
      ;;
  esac

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
    if [ -n "$(outputs "$r")" ]; then
      echo "| $(label "$r")$(parts_note "$r") | $(total "$r" checks) | $(total "$r" searches) | $(total "$r" skipped) |"
    else
      echo "| $(label "$r") | did not run | | |"
    fi
  done

  printf '\n<details>\n<summary>Not reviewed</summary>\n\n'
  for r in $reviewers; do
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '**%s%s**\n\n' "$(label "$r")" "$(part_label "$f")"
      h2 "$f" "3. Not reviewed" | trim | or_default "Nothing skipped."
      echo
    done < <(outputs "$r")
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

  printf '\n<details>\n<summary>Every check performed</summary>\n\n'
  for r in $reviewers; do
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '**%s%s**\n\n' "$(label "$r")" "$(part_label "$f")"
      h3 "$f" "Checks performed" | trim
      echo
    done < <(outputs "$r")
  done
  printf '**Behaviour coverage**\n\n'
  h3 "$verified" "Behaviour coverage" | trim | or_default "Not produced."
  printf '\n</details>\n'

  printf '\n<details>\n<summary>Run metadata</summary>\n\n'
  trim < "$run/report-meta.md"
  printf '\n</details>\n'
}

build_process() {
  local pr="$1" sha="$2"

  echo "<!-- agent-pr-review:process pr=$pr sha=$sha -->"
  echo "## Review of PR #$pr at \`$sha\`"
  echo

  # One data line, so later batches can count failure classes per first review and per
  # 1,000 changed lines without reading prose.
  local round lines began version
  if [ -s "$run/previous/report.md" ]; then round="re-review"; else round="first"; fi
  lines="$({ grep -o '"additions":[0-9]*' "$run/pr.json" | head -n 1; grep -o '"deletions":[0-9]*' "$run/pr.json" | head -n 1; } 2>/dev/null | cut -d: -f2 | awk '{ s += $1 } END { print s + 0 }')"
  began="$(sed -n 's/^======== [0-9a-f]* \([0-9T:Z-]*\) ========$/\1/p' "$run/commits.txt" 2>/dev/null | head -n 1 || true)"
  version="$(sed -n 's/^  harness-version: "\(.*\)"$/\1/p' "$(dirname "$0")/../SKILL.md" | head -n 1)"
  echo "Round: ${round} · Changed lines: ${lines:-unknown} · Work began: ${began:-unknown} · Harness version: ${version:-unknown} · Readiness: $(readiness_state) · Cost: $(cost_state)"
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
    need "$verified" "Summary" "Confirmed findings" "Minor findings table" "Rejected findings" "Spot checks" "Previous findings" "Convergence" "Verification summary" "Reviewer tables"
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

    whole="$run/report.md"
    build_report > "$whole"
    pr_number="$(grep -o '"number":[0-9]*' "$run/pr.json" 2>/dev/null | head -n 1 | cut -d: -f2)"
    write_findings_json "$run/findings.json"
    echo "wrote $run/findings.json ($(wc -l < "$run/findings.json" | tr -d ' ') findings)"
    rm -f "$run"/report-[0-9][0-9].md

    # Split into parts that each fit in one comment, leaving room for the part's marker,
    # heading and footer.
    here="$(cd "$(dirname "$0")" && pwd)"
    run_id="$(date -u +%Y%m%dT%H%M%SZ)"
    parts_dir="$(mktemp -d)"
    trap 'rm -rf "$parts_dir"' EXIT
    awk -v limit=$((SOFT_LIMIT - 600)) -f "$here/split-report.awk" "$whole" |
      awk -v dir="$parts_dir" 'BEGIN { n = 1; f = sprintf("%s/%02d", dir, n) } /^@@PART-BREAK@@$/ { close(f); n++; f = sprintf("%s/%02d", dir, n); next } { print > f }'
    n="$(ls "$parts_dir" | wc -l | tr -d ' ')"
    short="${report_sha:0:7}"

    for k in $(seq 1 "$n"); do
      kk="$(printf '%02d' "$k")"
      part="$run/report-$kk.md"
      {
        echo "<!-- agent-pr-review:report sha=$report_sha run=$run_id part=$k/$n -->"
        if [ "$k" -gt 1 ]; then
          echo "## Agent PR review of \`$short\`: part $k of $n"
          echo
          echo "_Continued from part $((k - 1)). The parts are consecutive comments; read them in order._"
          echo
        fi
        if [ "$k" -eq 1 ] && [ "$n" -gt 1 ]; then
          # After the report's first heading line.
          awk -v n="$n" 'NR == 1 { print; print ""; printf "_This review is in %d parts, posted as consecutive comments. This is part 1._\n", n; next } { print }' "$parts_dir/$kk"
        else
          cat "$parts_dir/$kk"
        fi
        if [ "$k" -lt "$n" ]; then
          echo
          echo "---"
          echo "_Continued in part $((k + 1)) of $n._"
        fi
      } > "$part"
      chars="$(size "$part")"
      [ "$chars" -le 65536 ] || too_long "$part" "$chars"
      echo "wrote $part ($chars characters, part $k of $n)"
    done
    echo "whole report: $whole ($(size "$whole") characters)"
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
