#!/usr/bin/env bash
# Build an issue's new description from a readiness round and the owner's answers,
# mechanically: nothing is applied that the owner did not answer, or accept through
# "Decision r<k>/ALL: accept" where that is allowed.
#
# Usage: apply-readiness.sh <issue-number> <run-dir> <round>
#
# Reads   <run-dir>/issue-body.md        the description as it is now (from get-readiness.sh)
#         <run-dir>/previous/round-<k>.md the readiness review of that round
#         the owner's answers, through get-issue-decisions.sh
# Writes  <run-dir>/issue-body.new.md     the new description
#         <run-dir>/applied.md            what was applied, what was not and why, what is open,
#                                         ready to post with post-readiness.sh
# Prints  a summary, ending with "open: <n>" (questions and items that still need an answer)
#
# Rules:
# - A question takes its explicit answer; with ALL, the recommended option.
# - An assumption stands unless corrected, except those marked "(verify first)" or
#   "(would have asked)" and those under "Check these first": they need an explicit answer
#   ("ok" to confirm, or a correction), ALL or not.
# - An edit is applied when accepted, explicitly or with ALL; its "Before" text must be
#   found verbatim, exactly once, or it is not applied.
# - An option chosen with "Owned paths: + `path`" adds each path to the Owned paths section.
# - The "Decisions and clarifications" section is created or extended; an entry that a later
#   round replaces is marked "superseded", never deleted. Each question's entry keeps the
#   options not chosen; each assumption keeps the lines it makes stale; the round's Reuse
#   pointers are carried over, since the coding agent reads the description, not the review.
# - Inside a fenced block (an edit's Before or After text) nothing is structure: a "##"
#   heading there is text to apply, not the end of the edit.

set -euo pipefail

if [ "$#" -ne 3 ] || [ ! -d "$2" ]; then
  echo "usage: $(basename "$0") <issue-number> <run-dir> <round>" >&2
  exit 2
fi

n="$1"
run="$(cd "$2" && pwd)"
k="$3"
here="$(cd "$(dirname "$0")" && pwd)"
round_file="$run/previous/round-${k}.md"
body="$run/issue-body.md"

[ -s "$round_file" ] || { echo "error: no readiness review of round $k at $round_file" >&2; exit 1; }
[ -f "$body" ] || { echo "error: no description snapshot at $body (run get-readiness.sh)" >&2; exit 1; }

# The owner's answers, as "<ID>\t<answer>\t<comment URL>". Table cells may hold an
# escaped pipe (\|): split on the others only, and unescape it in the text.
answers="$("$here/get-issue-decisions.sh" "$n" "$k" | awk '
  /^\| r[0-9]+\// {
    l = $0; gsub(/\\\|/, "\034", l); split(l, c, "|")
    id = c[2]; gsub(/^[ \t]+|[ \t]+$/, "", id); sub(/^r[0-9]+\//, "", id)
    ans = c[3]; gsub(/^[ \t]+|[ \t]+$/, "", ans); gsub(/\034/, "|", ans)
    url = c[6]; gsub(/^[ \t]+|[ \t]+$/, "", url)
    print id "\t" ans "\t" url
  }')"

{
  printf '%s\n' "$answers" | sed '/^$/d; s/^/ANS\t/'
  sed 's/^/ROUND\t/' "$round_file"
  printf 'BODYSTART\n'
  sed 's/^/BODY\t/' "$body"
} | awk -F'\t' -v k="$k" -v out_body="$run/issue-body.new.md" -v out_log="$run/applied.md" '
  function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
  function staled(x) { return (x in stale) ? " (makes stale: " stale[x] ")" : "" }

  $1 == "ANS" { ans[$2] = $3; url[$2] = $4; next }

  $1 == "ROUND" {
    line = substr($0, 7)
    # Fenced blocks: their lines are text, never structure.
    if (fence != "") {
      if (index(line, fence) == 1 && line ~ /^(`+|~+)[ \t]*$/) { fence = ""; next }
      if (mode == "e" && part == "before") before[eid] = before[eid] (hasb[eid]++ ? "\n" : "") line
      else if (mode == "e" && part == "after") after[eid] = after[eid] (hasa[eid]++ ? "\n" : "") line
      next
    }
    if (match(line, /^(```+|~~~+)/)) { fence = substr(line, 1, RLENGTH); next }
    # The Reuse pointers: the bullet and its indented continuation lines.
    if (inreuse) {
      if (line ~ /^[ \t]+[^ \t]/) { reuse = reuse "\n" line; next }
      inreuse = 0
    }
    if (line ~ /^- \*\*Reuse:\*\*/) { reuse = line; sub(/^- \*\*Reuse:\*\* */, "", reuse); inreuse = 1; next }
    if (line ~ /^Round: / && match(line, /Spec commit: [0-9a-f]+/)) spec = substr(line, RSTART + 13, 7)
    if (line ~ /^\*\*Check these first:\*\*/) {
      s = line; sub(/^\*\*Check these first:\*\* */, "", s); gsub(/[ `]/, "", s)
      m = split(s, ids, ","); for (i = 1; i <= m; i++) if (ids[i] != "") checkfirst[ids[i]] = 1
    }
    if (line ~ /^#### Q-[0-9]+:/) { cur = line; sub(/^#### /, "", cur); qid = cur; sub(/:.*/, "", qid); qtext[qid] = trim(substr(cur, length(qid) + 2)); qorder[++nq] = qid; mode = "q"; next }
    if (line ~ /^#### E-[0-9]+:/) { cur = line; sub(/^#### /, "", cur); eid = cur; sub(/:.*/, "", eid); etitle[eid] = trim(substr(cur, length(eid) + 2)); eorder[++ne] = eid; mode = "e"; part = ""; next }
    if (line ~ /^#{2,4} /) { mode = ""; next }
    if (mode == "q" && line ~ /^[ ]+- \([a-z]\) /) { l = line; sub(/^[ ]+- \(/, "", l); letter = substr(l, 1, 1); opt[qid, letter] = trim(substr(l, 4)); letters[qid] = letters[qid] letter; next }
    if (mode == "q" && line ~ /^- \*\*Edges:\*\* /) { l = line; sub(/^- \*\*Edges:\*\* */, "", l); edges[qid] = l; inedges = qid; next }
    if (mode == "q" && inedges != "" && line ~ /^[ \t]+[^ \t-]/) { edges[inedges] = edges[inedges] " " trim(line); next }
    inedges = ""
    if (mode == "q" && line ~ /^- \*\*Recommendation:\*\* \([a-z]\)/) { l = line; sub(/^- \*\*Recommendation:\*\* \(/, "", l); rec[qid] = substr(l, 1, 1); next }
    if (line ~ /^\| A-[0-9]+ \|/) {
      l = line; gsub(/\\\|/, "\034", l); split(l, c, "|")
      aid = trim(c[2]); atext[aid] = trim(c[3]); gsub(/\034/, "|", atext[aid]); aorder[++na] = aid
      st = trim(c[5]); gsub(/\034/, "|", st); gsub(/ *<br *\/?> */, "; ", st)
      if (tolower(st) !~ /^(nothing|none|n\/a|-|—)?\.?$/) stale[aid] = st
      if (atext[aid] ~ /\(verify first\)|\(would have asked\)/) aflag[aid] = 1
      if (atext[aid] ~ /replaces r[0-9]+\/[QAE]-[0-9]+/) { r = atext[aid]; match(r, /replaces r[0-9]+\/[QAE]-[0-9]+/); supersedes[aid] = substr(r, RSTART + 9, RLENGTH - 9) }
      next
    }
    if (mode == "e") {
      if (line ~ /^Before:/) { part = "before"; next }
      if (line ~ /^After:/) { part = "after"; next }
    }
    next
  }

  $0 == "BODYSTART" { inbody = 1; next }
  $1 == "BODY" { b = b (nb++ ? "\n" : "") substr($0, 6); next }

  END {
    all = ("ALL" in ans) && tolower(ans["ALL"]) ~ /^accept/
    log_applied = ""; log_skipped = ""; log_open = ""; entries = ""; open = 0

    # Edits.
    for (i = 1; i <= ne; i++) {
      e = eorder[i]; answered = (e in ans); a = answered ? tolower(ans[e]) : ""
      accepted = (a ~ /^accept/) || (all && !answered)
      if (a ~ /^reject/) { log_skipped = log_skipped "- " e " (" etitle[e] "): rejected\n"; continue }
      if (!accepted) { log_open = log_open "- " e " (" etitle[e] "): no answer\n"; open++; continue }
      if (before[e] == "") { b = b "\n\n" after[e]; log_applied = log_applied "- " e ": added (" etitle[e] ")\n"; continue }
      p = index(b, before[e])
      if (p == 0) { log_skipped = log_skipped "- " e " (" etitle[e] "): its Before text is not in the description any more; not applied\n"; continue }
      rest = substr(b, p + length(before[e]))
      if (index(rest, before[e]) > 0) { log_skipped = log_skipped "- " e " (" etitle[e] "): its Before text appears more than once; not applied\n"; continue }
      b = substr(b, 1, p - 1) after[e] rest
      log_applied = log_applied "- " e ": " etitle[e] "\n"
    }

    # Questions.
    for (i = 1; i <= nq; i++) {
      q = qorder[i]
      if (q in ans) { a = ans[q]; how = "answered" }
      else if (all && rec[q] != "") { a = "(" rec[q] ")"; how = "accepted the recommendation" }
      else { log_open = log_open "- " q ": " qtext[q] "\n"; open++; continue }
      text = a; chosen = ""
      if (a ~ /^\(?[a-z]\)?([ ,.]|$)/) { l = a; gsub(/[()]/, "", l); l = substr(l, 1, 1); if ((q, l) in opt) { text = "(" l ") " opt[q, l]; chosen = l } }
      # An option that widens the owned paths.
      t = text
      while (match(t, /\+ `[^`]+`/)) { path = substr(t, RSTART + 3, RLENGTH - 4); addpath[++npath] = path; t = substr(t, RSTART + RLENGTH) }
      link = (q in url) ? " ([answer](" url[q] "))" : " (accept all" ((("ALL" in url) ? ", [answer](" url["ALL"] ")" : "")) ")"
      entries = entries "- **r" k "/" q "** (settled against `" spec "`): " qtext[q] " → " text link "\n"
      if (edges[q] != "" && tolower(edges[q]) !~ /^none/) entries = entries "  - edges: " edges[q] "\n"
      # The options not chosen, so the agent and the reviewer know what was ruled out.
      for (z = 1; z <= length(letters[q]); z++) { l = substr(letters[q], z, 1); if (l != chosen) entries = entries "  - not chosen: (" l ") " opt[q, l] "\n" }
      log_applied = log_applied "- " q ": " how ", " text "\n"
    }

    # Assumptions.
    assumed = ""
    for (i = 1; i <= na; i++) {
      x = aorder[i]
      needs = aflag[x] || (x in checkfirst)
      if (x in ans) {
        a = ans[x]
        if (tolower(a) ~ /^(ok|confirm|confirmed|yes|agree)/) assumed = assumed "  - " x ": " atext[x] staled(x) " (confirmed" ((x in url) ? ", [answer](" url[x] ")" : "") ")\n"
        else entries = entries "- **r" k "/" x "** (settled against `" spec "`): " atext[x] " → corrected: " a ((x in url) ? " ([answer](" url[x] "))" : "") staled(x) "\n"
      } else if (needs) {
        log_open = log_open "- " x ": " atext[x] " (needs an explicit answer)\n"; open++
        continue
      } else {
        assumed = assumed "  - " x ": " atext[x] staled(x) "\n"
      }
      if (x in supersedes) { sup[supersedes[x]] = "r" k "/" x }
    }
    if (assumed != "") entries = entries "- **r" k ", assumed** (as of `" spec "`):\n" assumed
    # Reuse pointers from the review: guidance for the agent, not an owner decision.
    if (trim(reuse) != "" && tolower(trim(reuse)) !~ /^none/) entries = entries "- **r" k ", reuse** (from the readiness review, as of `" spec "`): " reuse "\n"

    # Owned paths.
    if (npath > 0) {
      m = split(b, L, "\n"); p = 0; last = 0
      for (j = 1; j <= m; j++) {
        if (L[j] ~ /^#+ .*[Oo]wned paths/) { p = j; last = j; continue }
        if (p && L[j] ~ /^#+ /) break
        if (p && L[j] ~ /[^ \t]/) last = j
      }
      if (p) {
        nb2 = ""
        for (j = 1; j <= m; j++) {
          nb2 = nb2 (j > 1 ? "\n" : "") L[j]
          if (j == last) for (z = 1; z <= npath; z++) nb2 = nb2 "\n- `" addpath[z] "`"
        }
        done = 1
      }
      if (done) { b = nb2; for (z = 1; z <= npath; z++) log_applied = log_applied "- owned path added: `" addpath[z] "`\n" }
      else log_skipped = log_skipped "- owned paths to add, but the description has no Owned paths section: " npath " path(s)\n"
    }

    # Superseded entries.
    for (old in sup) {
      m = split(b, L, "\n"); nb2 = ""
      for (j = 1; j <= m; j++) {
        if (index(L[j], "- **" old "**") == 1 && index(L[j], "superseded") == 0) L[j] = L[j] " — superseded by " sup[old]
        nb2 = nb2 (j > 1 ? "\n" : "") L[j]
      }
      b = nb2
    }

    # The decisions section.
    if (entries != "") {
      head = "## Decisions and clarifications"
      if (index(b, head) == 0) {
        b = b "\n\n" head "\n\nSettled before work started, by the owner, in answer to readiness reviews. Coding agents and PR reviewers treat these as part of the spec.\n\n" entries
      } else {
        p = index(b, head); after_head = substr(b, p + length(head))
        q2 = index(after_head, "\n## ")
        if (q2 == 0) b = b "\n" entries
        else b = substr(b, 1, p + length(head) + q2 - 1) entries substr(b, p + length(head) + q2)
      }
    }

    printf "%s\n", b > out_body
    printf "<!-- agent-pr-review:readiness-applied round=%s -->\n## Readiness answers applied (round %s)\n\nOnly `Decision r%s/<ID>: ...` lines count; other replies are not applied.%s\n\n**Applied:**\n%s\n**Not applied:**\n%s\n**Still open** (each needs its own `Decision` line):\n%s", k, k, k, (all ? " `ALL` accepted the recommendations and edits, but not the assumptions that need an explicit answer." : ""), (log_applied == "" ? "- nothing\n" : log_applied), (log_skipped == "" ? "- nothing\n" : log_skipped), (log_open == "" ? "- nothing\n" : log_open) > out_log
    printf "applied and skipped items are listed in %s\nopen: %d\n", out_log, open
  }'
