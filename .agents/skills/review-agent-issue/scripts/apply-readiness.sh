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
  # Continuation lines of a field, one level deeper under the sub-bullet that carries it.
  function nest(s) { gsub(/\n/, "\n  ", s); return s }
  function staled(x) { return (x in stale) ? " (makes stale: " stale[x] ")" : "" }
  # The earlier entries a line says it replaces or reopens, as " r1/A-11 r1/Q-2".
  function reopened(s,   out, m) {
    out = ""
    while (match(s, /(reopens|replaces|supersedes) r[0-9]+\/[QAE]-[0-9]+/)) {
      m = substr(s, RSTART, RLENGTH); sub(/^[a-z]+ /, "", m); out = out " " m; s = substr(s, RSTART + RLENGTH)
    }
    return out
  }
  function nothing(s) { return tolower(trim(s)) ~ /^(nothing|none|n\/a|-|—)?([ .:;(]|$)/ }
  # Mentions of this round'"'"'s options ("Q-1 (a)", "Q-1 (a) or (b)") that name none of the
  # options the owner chose: the text was written for another answer.
  # Text that covers several options in turn ("Under Q-1 (a) or (b) ...; under Q-1 (c) ...")
  # is fine as long as one of its mentions includes the chosen option.
  function contradicts(s, who,   m, q, letters, seen, nq2, qs, i) {
    split("", seen); nq2 = 0
    while (match(s, /(^|[^\/A-Za-z0-9])Q-[0-9]+ \([a-z]\)(( or | and |, )\([a-z]\))*/)) {
      m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
      q = m; sub(/^[^Q]*/, "", q); sub(/ .*/, "", q)
      letters = m; sub(/^[^(]*/, "", letters); gsub(/[^a-z]/, "", letters)
      if (!(q in seen)) qs[++nq2] = q
      seen[q] = seen[q] letters
    }
    for (i = 1; i <= nq2; i++) {
      q = qs[i]
      if ((q in chosenq) && chosenq[q] != "" && index(seen[q], chosenq[q]) == 0)
        checks = checks "- " who " mentions only " q " (" seen[q] "), but (" chosenq[q] ") was chosen: check whether it still applies\n"
    }
  }

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
    if (line ~ /^#### Q-[0-9]+:/) { cur = line; sub(/^#### /, "", cur); qid = cur; sub(/:.*/, "", qid); qtext[qid] = trim(substr(cur, length(qid) + 2)); qorder[++nq] = qid; mode = "q"; qsup[qid] = qsup[qid] reopened(line); next }
    if (mode == "q") qsup[qid] = qsup[qid] reopened(line)
    if (line ~ /^#### E-[0-9]+:/) { cur = line; sub(/^#### /, "", cur); eid = cur; sub(/:.*/, "", eid); etitle[eid] = trim(substr(cur, length(eid) + 2)); eorder[++ne] = eid; mode = "e"; part = ""; next }
    if (line ~ /^#{2,4} /) { mode = ""; next }
    if (mode == "q" && line ~ /^[ ]+- \([a-z]\) /) { l = line; sub(/^[ ]+- \(/, "", l); letter = substr(l, 1, 1); opt[qid, letter] = trim(substr(l, 4)); letters[qid] = letters[qid] letter; next }
    # The "Makes stale" and "Edges" fields of a question: the first line and every indented line
    # after it, nested bullets included ("each case below:" followed by "  - ...").
    if (mode == "q" && field != "" && line ~ /^[ \t]+[^ \t]/) { if (field == "edges") edges[qid] = edges[qid] "\n" line; else qstale[qid] = qstale[qid] "\n" line; next }
    field = ""
    if (mode == "q" && line ~ /^- \*\*Makes stale:\*\* /) { l = line; sub(/^- \*\*Makes stale:\*\* */, "", l); qstale[qid] = l; field = "stale"; next }
    if (mode == "q" && line ~ /^- \*\*Edges:\*\* /) { l = line; sub(/^- \*\*Edges:\*\* */, "", l); edges[qid] = l; field = "edges"; next }
    if (mode == "q" && line ~ /^- \*\*Recommendation:\*\* \([a-z]\)/) { l = line; sub(/^- \*\*Recommendation:\*\* \(/, "", l); rec[qid] = substr(l, 1, 1); next }
    if (line ~ /^\| A-[0-9]+([ \t][^|]*)? \|/) {
      l = line; gsub(/\\\|/, "\034", l); split(l, c, "|")
      # The ID cell may carry the marker too ("A-4 (verify first)"): the ID is "A-4", and the
      # marker moves to the front of the assumption, where the rules below look for it.
      idcell = trim(c[2]); match(idcell, /A-[0-9]+/); aid = substr(idcell, RSTART, RLENGTH)
      mark = idcell; sub(/^A-[0-9]+[ \t]*/, "", mark)
      atext[aid] = trim((mark != "" ? mark " " : "") trim(c[3])); gsub(/\034/, "|", atext[aid]); aorder[++na] = aid
      st = trim(c[5]); gsub(/\034/, "|", st); gsub(/ *<br *\/?> */, "; ", st)
      if (!nothing(st)) stale[aid] = st
      if (atext[aid] ~ /\(verify first\)|\(would have asked\)/) aflag[aid] = 1
      supersedes[aid] = reopened(atext[aid])
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
      # Every path in "Owned paths: + `a`, `b` and `c`": the list ends at the first text that
      # is not a path or a separator, so a backticked word in a following note is not taken.
      t = text
      while ((p = index(t, "Owned paths: +")) > 0) {
        t = substr(t, p + length("Owned paths: +"))
        while (match(t, /^([ ,]|and |\+)*`[^`]+`/)) {
          seg = substr(t, 1, RLENGTH); t = substr(t, RLENGTH + 1)
          match(seg, /`[^`]+`$/); path = substr(seg, RSTART + 1, RLENGTH - 2)
          # A qualifier in parentheses right after a path belongs to it; the list goes on after it.
          qual = ""
          if (match(t, /^ *\(/)) {
            depth = 0
            for (y = RLENGTH; y <= length(t); y++) { ch = substr(t, y, 1); if (ch == "(") depth++; else if (ch == ")" && --depth == 0) break }
            qual = trim(substr(t, 1, y)); t = substr(t, y + 1)
          }
          if (!(path in seenpath)) { seenpath[path] = 1; addpath[++npath] = path; addqual[npath] = qual }
        }
      }
      link = (q in url) ? " ([answer](" url[q] "))" : " (accept all" ((("ALL" in url) ? ", [answer](" url["ALL"] ")" : "")) ")"
      entries = entries "- **r" k "/" q "** (settled against `" spec "`): " qtext[q] " → " text link "\n"
      chosenq[q] = chosen
      if (qstale[q] != "" && !nothing(qstale[q])) entries = entries "  - makes stale: " nest(qstale[q]) "\n"
      m2 = split(qsup[q], olds, " "); for (z = 1; z <= m2; z++) if (olds[z] != "") sup[olds[z]] = "r" k "/" q
      if (edges[q] != "" && tolower(edges[q]) !~ /^none/) entries = entries "  - edges: " nest(edges[q]) "\n"
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
      m2 = split(supersedes[x], olds, " "); for (z = 1; z <= m2; z++) if (olds[z] != "") sup[olds[z]] = "r" k "/" x
    }
    if (assumed != "") entries = entries "- **r" k ", assumed** (as of `" spec "`):\n" assumed
    # Reuse pointers go to their own section: guidance from the review, not owner decisions.
    notes = ""
    if (trim(reuse) != "" && !nothing(reuse)) notes = "- **r" k ", reuse** (as of `" spec "`): " reuse "\n"

    # Text written for an answer the owner did not choose.
    checks = ""
    for (i = 1; i <= na; i++) contradicts(atext[aorder[i]], aorder[i])
    for (i = 1; i <= nq; i++) contradicts(edges[qorder[i]], qorder[i] "'"'"'s edges")
    for (i = 1; i <= ne; i++) contradicts(after[eorder[i]], eorder[i])

    # Owned paths.
    if (npath > 0) {
      m = split(b, L, "\n"); p = 0; last = 0
      for (j = 1; j <= m; j++) {
        if (L[j] ~ /^#+ .*[Oo]wned paths/) { p = j; last = j; continue }
        if (p && L[j] ~ /^#+ /) break
        if (p && L[j] ~ /[^ \t]/) last = j
      }
      if (p) {
        for (j = p + 1; j <= last; j++) for (z = 1; z <= npath; z++) if (index(L[j], "`" addpath[z] "`")) listed[z] = 1
        nb2 = ""
        for (j = 1; j <= m; j++) {
          nb2 = nb2 (j > 1 ? "\n" : "") L[j]
          if (j == last) for (z = 1; z <= npath; z++) if (!listed[z]) nb2 = nb2 "\n- `" addpath[z] "`" (addqual[z] != "" ? " " addqual[z] : "")
        }
        done = 1
      }
      if (done) { b = nb2; for (z = 1; z <= npath; z++) log_applied = log_applied "- owned path " (listed[z] ? "already listed" : "added") ": `" addpath[z] "`\n" }
      else log_skipped = log_skipped "- owned paths to add, but the description has no Owned paths section: " npath " path(s)\n"
    }

    # Superseded entries: "- **r1/Q-2** ...", an item "  - A-11: ..." of "- **r1, assumed**",
    # or a hand-written "- **r1, assumed (A-11):** ...".
    for (old in sup) {
      oround = old; sub(/\/.*/, "", oround); oid = old; sub(/^[^\/]*\//, "", oid)
      m = split(b, L, "\n"); nb2 = ""; blk = ""; hit = 0
      for (j = 1; j <= m; j++) {
        if (L[j] ~ /^- \*\*/) blk = (index(L[j], "- **" oround ", assumed**") == 1) ? oround : ""
        if (index(L[j], "- **" old "**") == 1 || index(L[j], "- **" oround ", assumed (" oid ")") == 1 || (blk != "" && index(L[j], "  - " oid ":") == 1)) {
          if (index(L[j], "superseded") == 0) { L[j] = L[j] " — superseded by " sup[old]; hit = 1 } else if (!hit) hit = 2
        }
        nb2 = nb2 (j > 1 ? "\n" : "") L[j]
      }
      b = nb2
      log_applied = log_applied "- " old (hit == 1 ? " marked superseded by " sup[old] : hit == 2 ? ": already marked superseded" : ": superseded by " sup[old] ", but no entry for it was found in the description") "\n"
    }

    # The decisions section.
    if (entries != "") {
      head = "## Decisions and clarifications"
      if (index(b, head) == 0) {
        b = b "\n\n" head "\n\nSettled before work started, in answer to readiness reviews: the owner'"'"'s answers, and the assumptions the owner let stand. Coding agents and PR reviewers treat these as part of the spec.\n\n" entries
      } else {
        p = index(b, head); after_head = substr(b, p + length(head))
        q2 = index(after_head, "\n## ")
        if (q2 == 0) b = b "\n" entries
        else b = substr(b, 1, p + length(head) + q2 - 1) entries substr(b, p + length(head) + q2)
      }
    }

    # The readiness notes section: pointers, not decisions.
    if (notes != "") {
      head = "## Readiness notes"
      if (index(b, head) == 0) b = b "\n\n" head "\n\nPointers from readiness reviews. They are not owner decisions: follow them, or say in the PR why not.\n\n" notes
      else {
        p = index(b, head); after_head = substr(b, p + length(head)); q2 = index(after_head, "\n## ")
        if (q2 == 0) b = b "\n" notes; else b = substr(b, 1, p + length(head) + q2 - 1) notes substr(b, p + length(head) + q2)
      }
    }

    printf "%s\n", b > out_body
    printf "<!-- agent-pr-review:readiness-applied round=%s -->\n## Readiness answers applied (round %s)\n\nOnly `Decision r%s/<ID>: ...` lines count; other replies are not applied.%s\n\n**Applied:**\n%s\n**Not applied:**\n%s\n**Still open** (each needs its own `Decision` line):\n%s%s", k, k, k, (all ? " `ALL` accepted the recommendations and edits, but not the assumptions that need an explicit answer." : ""), (log_applied == "" ? "- nothing\n" : log_applied), (log_skipped == "" ? "- nothing\n" : log_skipped), (log_open == "" ? "- nothing\n" : log_open), (checks == "" ? "" : "\n**To check** (written for an answer you did not choose; correct with a new `Decision` line or a refresh):\n" checks) > out_log
    printf "applied and skipped items are listed in %s\nopen: %d\nto check: %d\n", out_log, open, gsub(/\n/, "\n", checks)
  }'
