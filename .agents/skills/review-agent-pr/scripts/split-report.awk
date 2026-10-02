# Split a review report into parts that each fit in one GitHub comment.
#
# Usage: awk -v limit=<bytes per part> -f split-report.awk <report body>
#
# Prints the parts separated by a line holding only "@@PART-BREAK@@". Splits only between
# units: the header, a "### " section heading, a "#### " finding, a top-level <details>
# block, or the minor-findings table. A part that starts in the middle of a section repeats
# the section heading with "(continued)". A unit too large for a part on its own is split
# between lines; a table split this way repeats its header rows, and a <details> block is
# closed and reopened with "(continued)" in its summary.

function flush_unit() {
  if (ulen == 0) return
  units++
  utext[units] = ubuf
  usize[units] = ulen
  usec[units] = cursec
  ubuf = ""
  ulen = 0
}

{
  line = $0
  starts = 0
  if (depth == 0 && (line ~ /^### / || line ~ /^#### / || line ~ /^<details>/ || line ~ /^\*\*Minor findings and nits\*\*/)) starts = 1
  if (starts) {
    flush_unit()
    if (line ~ /^### /) cursec = substr(line, 5)
  }
  if (line ~ /^<details>/) depth++
  if (line ~ /^<\/details>/ && depth > 0) depth--
  ubuf = ubuf line "\n"
  ulen += length(line) + 1
}

function emit(text) {
  out = out text
  size += length(text)
}

function new_part(sec, starts_section) {
  if (size > 0) {
    printf "%s", out
    print "@@PART-BREAK@@"
  }
  out = ""
  size = 0
  if (sec != "" && !starts_section) emit("### " sec " (continued)\n\n")
}

# Split one oversized unit between lines.
function split_unit(text, sec,    n, l, i, ln, in_details, summary, hdr1, hdr2, prev_table, opener) {
  n = split(text, l, "\n")
  in_details = (l[1] ~ /^<details>/)
  summary = ""
  for (i = 1; i <= n; i++) if (l[i] ~ /^<summary>/) { summary = l[i]; break }
  sub(/<\/summary>/, " (continued)</summary>", summary)
  hdr1 = ""; hdr2 = ""; prev_table = 0
  for (i = 1; i <= n; i++) {
    ln = l[i]
    if (i == n && ln == "") break
    is_table = (ln ~ /^\|/)
    if (is_table && !prev_table) { hdr1 = ln; hdr2 = (i < n ? l[i + 1] : "") }
    if (size + length(ln) + 1 > limit - 200) {
      if (in_details) emit("\n</details>\n")
      new_part(sec, 0)
      if (in_details) emit("<details>\n" summary "\n\n")
      if (is_table && prev_table && ln != hdr2) emit(hdr1 "\n" hdr2 "\n")
    }
    emit(ln "\n")
    prev_table = is_table
    if (!is_table) { hdr1 = ""; hdr2 = "" }
  }
}

END {
  flush_unit()
  out = ""; size = 0
  for (u = 1; u <= units; u++) {
    starts_section = (utext[u] ~ /^### /)
    if (size + usize[u] <= limit) {
      emit(utext[u])
    } else if (usize[u] <= limit) {
      new_part(usec[u], starts_section)
      emit(utext[u])
    } else {
      if (size > 0 && size + 2000 > limit) new_part(usec[u], starts_section)
      split_unit(utext[u], usec[u])
    }
  }
  printf "%s", out
}
