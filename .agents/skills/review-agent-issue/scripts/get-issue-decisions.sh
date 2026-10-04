#!/usr/bin/env bash
# List the owner's answers to a readiness review, as posted on the issue.
#
# Usage: get-issue-decisions.sh <issue-number> <round>
#
# An answer is a line in an issue comment of the form
#   Decision r<round>/<ID>: <answer>
# where ID is a question (Q-1), an assumption the owner objects to (A-1) or a suggested edit
# (E-1), for example "Decision r1/Q-2: (b)" or "Decision r1/E-1: accept". It counts when the
# comment was posted after the readiness review of that round, is not one of the harness's
# own comments, and its author may decide for the repository: the repository's owner always
# may; anyone else needs write, maintain or admin access; if that lookup is refused, a
# MEMBER or COLLABORATOR is accepted and marked "not confirmed". A later answer to the same
# ID replaces an earlier one.
#
# Prints a markdown table of the answers that count, then what was ignored and why, or
# "No decisions posted.". Uses the REST API only.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <issue-number> <round>" >&2
  exit 2
fi

n="$1"
round="$2"
case "$n" in '' | *[!0-9]*) echo "error: issue number must be numeric, got '$n'" >&2; exit 2 ;; esac
case "$round" in '' | *[!0-9]*) echo "error: round must be numeric, got '$round'" >&2; exit 2 ;; esac

since_prog='.[] | select(.body | startswith("<!-- agent-pr-review:readiness round=ROUND ")) | .created_at'
since="$(gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" --jq "${since_prog//ROUND/$round}" | sort | head -n 1)"
if [ -z "$since" ]; then
  echo "error: issue #${n} has no readiness review of round ${round}" >&2
  exit 1
fi

lines_prog='.[] | select(.created_at > "SINCE")
  | select(.body | startswith("<!-- agent-pr-review:") | not)
  | . as $c
  | .body | split("\n")[]
  | sub("\r$"; "") | sub("^[ >]*`?"; "") | sub("`[ ]*$"; "")
  | select(test("^Decision r[0-9]+/[QAE]-[0-9]+: "))
  | "\($c.created_at)\t\($c.user.login)\t\($c.author_association)\t\($c.html_url)\t\(.)"'
lines="$(gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" --jq "${lines_prog//SINCE/$since}" | sort)"

if [ -z "$lines" ]; then
  echo "No decisions posted."
  exit 0
fi

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

authority() {
  local login="$1" association="$2"
  if [ "$association" = "OWNER" ]; then verdict="yes	repository owner"; return; fi
  lookup_permission "$login"
  case "$perm" in
    admin | maintain | write) verdict="yes	$perm access" ;;
    unknown)
      case "$association" in
        MEMBER | COLLABORATOR) verdict="yes	$(printf '%s' "$association" | tr '[:upper:]' '[:lower:]'), write access not confirmed (lookup refused)" ;;
        *) verdict="no	$login could not be confirmed to have write access (lookup refused; author association: $association)" ;;
      esac ;;
    *) verdict="no	$login has $perm access, not write" ;;
  esac
}

accepted=""
ignored=""
while IFS="$(printf '\t')" read -r posted login association url text; do
  ref="${text#Decision }"
  ref="${ref%%: *}"
  line_round="${ref%%/*}"
  line_round="${line_round#r}"
  id="${ref#*/}"
  answer="${text#*: }"
  if [ "$line_round" != "$round" ]; then
    ignored="$ignored
- $id ($url): names round $line_round, not $round"
    continue
  fi
  authority "$login" "$association"
  if [ "${verdict%%	*}" != "yes" ]; then
    ignored="$ignored
- $id ($url): ${verdict#*	}"
    continue
  fi
  accepted="$(printf '%s\n' "$accepted" | awk -F'\t' -v id="$id" '$1 != id && NF')
$id	$answer	$login (${verdict#*	})	$posted	$url"
done <<< "$lines"

if [ -n "$(printf '%s' "$accepted" | tr -d '[:space:]')" ]; then
  echo "| Item | Answer | By | Posted | Comment |"
  echo "|---|---|---|---|---|"
  printf '%s\n' "$accepted" | awk -F'\t' -v r="$round" 'NF { printf "| r%s/%s | %s | %s | %s | %s |\n", r, $1, $2, $3, $4, $5 }'
else
  echo "No decisions posted."
fi
if [ -n "$ignored" ]; then
  echo
  echo "Ignored:$ignored"
fi
