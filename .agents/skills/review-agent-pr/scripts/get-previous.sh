#!/usr/bin/env bash
# Save the previous reviews of a PR, if there are any, for a re-review or re-check.
#
# Usage: get-previous.sh <pr-number> <run-dir>
#
# Writes into <run-dir>/previous/:
#   report.md                 the latest review report on the PR (parts joined)
#   earlier/report-<sha>.md   the last report of each earlier reviewed commit
#   responses.md              every response from the authoring agent (address-pr-review),
#                             oldest first, each under a header with its comment ID and time
#   decisions.md              the owner's decisions posted on the PR ("Decision <sha>/<ID>:
#                             ..." lines), per reviewed commit, from get-decisions.sh
# Prints what was found, starting with "previous-commit: <sha>". Writes nothing and prints
# "no previous review" when the PR has no report comment.
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

RESPONSE_MARKER='<!-- agent-pr-review:response'

if [ "$#" -ne 2 ] || [ ! -d "$2" ]; then
  echo "usage: $(basename "$0") <pr-number> <run-dir>" >&2
  exit 2
fi

pr="$1"
out="$2/previous"

case "$pr" in
  '' | *[!0-9]*)
    echo "error: PR number must be numeric, got '$pr'" >&2
    exit 2
    ;;
esac

# The reviewed commit of a report body: from the marker, or from the header of reports
# written before the marker carried it.
reviewed_sha() {
  local sha
  sha="$(printf '%s\n' "$1" | head -n 1 | sed -n 's/^<!-- agent-pr-review:report sha=\([0-9a-f]*\) -->$/\1/p')"
  if [ -z "$sha" ]; then
    sha="$(printf '%s\n' "$1" | sed -nE 's/.*\*\*(Head|Reviewed commit):\*\* \[?`([0-9a-f]+)`.*/\2/p' | head -n 1)"
  fi
  printf '%s' "$sha"
}

here="$(cd "$(dirname "$0")" && pwd)"
reports_dir="$(mktemp -d)"
trap 'rm -rf "$reports_dir"' EXIT

# Every report, oldest first, with the parts of multi-comment reports joined.
reports="$("$here/get-reports.sh" "$pr" "$reports_dir")"

if [ -z "$reports" ]; then
  echo "no previous review"
  exit 0
fi

mkdir -p "$out"
IFS="$(printf '\t')" read -r latest_file latest_sha _ _ _ <<< "$(printf '%s\n' "$reports" | tail -n 1)"
cp "$latest_file" "$out/report.md"
echo "previous-commit: ${latest_sha:-unknown}"
echo "previous report: $out/report.md"

save_earlier() {
  local sha="$1" body="$2"
  [ -n "$sha" ] || return 0
  if [ -n "$latest_sha" ]; then
    case "$latest_sha" in "$sha"*) return 0 ;; esac
    case "$sha" in "$latest_sha"*) return 0 ;; esac
  fi
  mkdir -p "$out/earlier"
  printf '%s\n' "$body" > "$out/earlier/report-${sha:0:7}.md"
}

# Oldest first throughout, so the last report of each commit is the one kept.

# Reports from before every run got its own comment were edited in place; their earlier
# rounds survive only in the comment's edit history. That history is only available through
# GraphQL; where GraphQL is blocked (some cloud environments), those rounds are skipped and
# said so. Everything else here uses REST.
edits_query='query($id: ID!) { node(id: $id) { ... on IssueComment { userContentEdits(first: 50) { nodes { diff } } } } }'
legacy_ids="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq '.[] | select(.body | split("\n")[0] == "<!-- agent-pr-review:report -->") | .id'
)"
for id in $legacy_ids; do
  first_line="$(gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.body | split("\n")[0]')"
  [ "$first_line" = "<!-- agent-pr-review:report -->" ] || continue
  node="$(gh api "repos/{owner}/{repo}/issues/comments/${id}" --jq '.node_id')"
  if ! count="$(gh api graphql -f query="$edits_query" -f id="$node" --jq '.data.node.userContentEdits.nodes | length' 2>/dev/null)"; then
    echo "note: comment ${id} was edited in place by an older version of this skill, and its earlier rounds could not be read (GraphQL unavailable)"
    continue
  fi
  i="$count"
  while [ "$i" -gt 0 ]; do
    i=$((i - 1))
    body="$(gh api graphql -f query="$edits_query" -f id="$node" --jq ".data.node.userContentEdits.nodes[$i].diff // \"\"" 2>/dev/null || true)"
    save_earlier "$(reviewed_sha "$body")" "$body"
  done
done

# Earlier reports.
while IFS="$(printf '\t')" read -r file sha _ _ _; do
  [ -n "$file" ] || continue
  save_earlier "$sha" "$(cat "$file")"
done <<< "$(printf '%s\n' "$reports" | sed '$d')"

if [ -d "$out/earlier" ]; then
  for f in "$out"/earlier/report-*.md; do
    echo "earlier round: $f"
  done
fi

# The owner's decisions, for the latest reviewed commit and each earlier one.
here="$(cd "$(dirname "$0")" && pwd)"
{
  for s in $latest_sha $(ls "$out/earlier" 2>/dev/null | sed -n 's/^report-\([0-9a-f]*\)\.md$/\1/p'); do
    printf '## Decisions on the review of %s\n\n' "${s:0:7}"
    "$here/get-decisions.sh" "$pr" "$s" 2>&1 || true
    echo
  done
} > "$out/decisions.md"
echo "decisions: $out/decisions.md ($(grep -c '^| [0-9a-f]\{7\}/' "$out/decisions.md" || true) posted)"

responses="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq ".[] | select(.body | startswith(\"${RESPONSE_MARKER}\")) | \"======== response comment \\(.id), posted \\(.created_at) ========\\n\\(.body)\\n\""
)"
if [ -n "$responses" ]; then
  printf '%s\n' "$responses" > "$out/responses.md"
  echo "responses: $out/responses.md ($(printf '%s\n' "$responses" | grep -c '^======== response comment ') comments)"
else
  echo "no response from the authoring agent"
fi
