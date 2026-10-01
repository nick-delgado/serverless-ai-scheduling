#!/usr/bin/env bash
# Save the previous review of a PR, if there is one, for a re-review.
#
# Usage: get-previous.sh <pr-number> <run-dir>
#
# Writes into <run-dir>/previous/:
#   report.md    the current review report comment on the PR
#   response.md  the authoring agent's response comment (address-pr-review), if any
# Prints what was found. Writes nothing and prints "no previous review" when the PR has no
# report comment.
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

REPORT_MARKER='<!-- agent-pr-review:report -->'
RESPONSE_MARKER='<!-- agent-pr-review:response -->'

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

latest() {
  gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq ".[] | select(.body | startswith(\"$1\")) | .id" |
    tail -n 1
}

report_id="$(latest "$REPORT_MARKER")"
if [ -z "$report_id" ]; then
  echo "no previous review"
  exit 0
fi

mkdir -p "$out"
gh api "repos/{owner}/{repo}/issues/comments/${report_id}" --jq '.body' > "$out/report.md"
reviewed="$(sed -n 's/.*\*\*Head:\*\* `\([0-9a-f]*\)`.*/\1/p' "$out/report.md" | head -n 1)"
echo "previous report: $out/report.md (reviewed commit: ${reviewed:-unknown})"

# The report comment is updated in place, so earlier rounds survive only in its edit
# history. Save the last version of each earlier reviewed commit.
node="$(gh api "repos/{owner}/{repo}/issues/comments/${report_id}" --jq '.node_id')"
edits_query='query($id: ID!) { node(id: $id) { ... on IssueComment { userContentEdits(first: 50) { nodes { editedAt diff } } } } }'
count="$(gh api graphql -f query="$edits_query" -f id="$node" --jq '.data.node.userContentEdits.nodes | length' 2>/dev/null || echo 0)"
seen=" ${reviewed} "
i=0
while [ "$i" -lt "$count" ]; do
  body="$(gh api graphql -f query="$edits_query" -f id="$node" --jq ".data.node.userContentEdits.nodes[$i].diff // \"\"")"
  sha="$(printf '%s\n' "$body" | sed -n 's/.*\*\*Head:\*\* `\([0-9a-f]*\)`.*/\1/p' | head -n 1)"
  if [ -n "$sha" ]; then
    case "$seen" in
      *" $sha "*) ;;
      *)
        mkdir -p "$out/earlier"
        printf '%s\n' "$body" > "$out/earlier/report-$sha.md"
        echo "earlier round: $out/earlier/report-$sha.md (reviewed commit: $sha)"
        seen="$seen$sha "
        ;;
    esac
  fi
  i=$((i + 1))
done

response_id="$(latest "$RESPONSE_MARKER")"
if [ -n "$response_id" ]; then
  gh api "repos/{owner}/{repo}/issues/comments/${response_id}" --jq '.body' > "$out/response.md"
  echo "response: $out/response.md"
else
  echo "no response from the authoring agent"
fi
