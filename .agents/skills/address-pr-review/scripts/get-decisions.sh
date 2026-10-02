#!/usr/bin/env bash
# List the owner's decisions on a review's findings, as posted on the PR.
#
# Usage: get-decisions.sh <pr-number> <reviewed-sha>
#
# A decision is a line in a PR comment of the form
#   Decision <reviewed sha>/<finding ID>: <answer>
# for example "Decision d34b6df/SPEC-1: (b)". It counts when the comment was posted after
# the review of that commit, is not one of the harness's own comments, and its author may
# decide for the repository:
#   - the repository's owner (GitHub's author association OWNER) always may;
#   - anyone else needs write, maintain or admin access, looked up through the REST API;
#   - if that lookup is refused (some proxied or cloud environments block it), a MEMBER or
#     COLLABORATOR is accepted and the table says the access was not confirmed; anyone else
#     is ignored, with the reason.
# A later decision on the same finding replaces an earlier one.
#
# Prints a markdown table of the decisions that count, then any lines that were ignored and
# why. Prints "No decisions posted." when there are none.
# Run from inside a clone of the PR's repository. Requires an authenticated gh.
#
# The same script ships with the review-agent-pr and address-pr-review skills; keep the two
# copies identical.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <pr-number> <reviewed-sha>" >&2
  exit 2
fi

pr="$1"
sha="$2"

case "$pr" in '' | *[!0-9]*) echo "error: PR number must be numeric, got '$pr'" >&2; exit 2 ;; esac
printf '%s' "$sha" | grep -qE '^[0-9a-f]{7,40}$' || { echo "error: give the reviewed commit (7 to 40 hex characters), got '$sha'" >&2; exit 2; }
short="${sha:0:7}"

# When the review of this commit was posted: the earliest report comment that names it.
since_prog='.[] | select(.body | startswith("<!-- agent-pr-review:report"))
  | select(.body | test("sha=SHORT|(Head|Reviewed commit):\\*\\* \\[?`SHORT"))
  | .created_at'
since="$(gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" --jq "${since_prog//SHORT/$short}" | sort | head -n 1)"

if [ -z "$since" ]; then
  # Reports from before every run got its own comment were edited in place, so an earlier
  # round may have no comment of its own. Count from the first report on the PR instead.
  since="$(gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" \
    --jq '.[] | select(.body | startswith("<!-- agent-pr-review:report")) | .created_at' | sort | head -n 1)"
  if [ -z "$since" ]; then
    echo "error: no review report on PR #${pr}" >&2
    exit 1
  fi
  echo "note: no report comment of commit ${short} of its own; counting decisions posted since the first report (${since})" >&2
fi

# Decision lines in later comments that are not the harness's own. Quoting and the code
# formatting a line gets when copied from the report are stripped.
lines_prog='.[] | select(.created_at > "SINCE")
  | select(.body | startswith("<!-- agent-pr-review:") | not)
  | . as $c
  | .body | split("\n")[]
  | sub("\r$"; "") | sub("^[ >]*`?"; "") | sub("`[ ]*$"; "")
  | select(test("^Decision [0-9a-f]{7,40}/[A-Z]+-[0-9]+[a-z]?: "))
  | "\($c.created_at)\t\($c.user.login)\t\($c.author_association)\t\($c.html_url)\t\(.)"'
lines="$(gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" --jq "${lines_prog//SINCE/$since}" | sort)"

if [ -z "$lines" ]; then
  echo "No decisions posted."
  exit 0
fi

# The author's permission on the repository, set in $perm: admin, maintain, write, triage,
# read or none, or "unknown" when the lookup is refused. Cached per author.
perm_cache=""
lookup_permission() {
  local login="$1"
  perm="$(printf '%s\n' "$perm_cache" | awk -F'\t' -v l="$login" '$1 == l { print $2 }')"
  if [ -z "$perm" ]; then
    perm="$(gh api "repos/{owner}/{repo}/collaborators/${login}/permission" --jq '.permission' 2>/dev/null || true)"
    [ -n "$perm" ] || perm="unknown"
    perm_cache="$perm_cache
$login	$perm"
  fi
}

# Whether the author may decide, set in $verdict: "yes<TAB><authority to record>" or
# "no<TAB><reason>".
authority() {
  local login="$1" association="$2"
  if [ "$association" = "OWNER" ]; then
    verdict="yes	repository owner"
    return
  fi
  lookup_permission "$login"
  case "$perm" in
    admin | maintain | write) verdict="yes	$perm access" ;;
    unknown)
      case "$association" in
        MEMBER | COLLABORATOR)
          verdict="yes	$(printf '%s' "$association" | tr '[:upper:]' '[:lower:]'), write access not confirmed (lookup refused)" ;;
        *) verdict="no	$login could not be confirmed to have write access (lookup refused; author association: $association)" ;;
      esac
      ;;
    *) verdict="no	$login has $perm access, not write" ;;
  esac
}

accepted=""
ignored=""
while IFS="$(printf '\t')" read -r posted login association url text; do
  ref="${text#Decision }"
  ref="${ref%%: *}"
  line_sha="${ref%%/*}"
  id="${ref#*/}"
  answer="${text#*: }"
  case "$sha" in
    "$line_sha"*) ;;
    *)
      case "$line_sha" in
        "$sha"*) ;;
        *) ignored="$ignored
- $id ($url): names commit $line_sha, not $short"; continue ;;
      esac
      ;;
  esac
  authority "$login" "$association"
  if [ "${verdict%%	*}" != "yes" ]; then
    ignored="$ignored
- $id ($url): ${verdict#*	}"
    continue
  fi
  who="${verdict#*	}"
  # A later decision on the same finding replaces an earlier one.
  accepted="$(printf '%s\n' "$accepted" | awk -F'\t' -v id="$id" '$1 != id && NF')
$id	$answer	$login ($who)	$posted	$url"
done <<< "$lines"

if [ -n "$(printf '%s' "$accepted" | tr -d '[:space:]')" ]; then
  echo "| Finding | Decision | By | Posted | Comment |"
  echo "|---|---|---|---|---|"
  printf '%s\n' "$accepted" | awk -F'\t' -v s="$short" 'NF { printf "| %s/%s | %s | %s | %s | %s |\n", s, $1, $2, $3, $4, $5 }'
else
  echo "No decisions posted."
fi

if [ -n "$ignored" ]; then
  echo
  echo "Ignored:$ignored"
fi
