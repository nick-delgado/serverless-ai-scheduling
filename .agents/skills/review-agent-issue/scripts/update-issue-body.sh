#!/usr/bin/env bash
# Replace an issue's description, but only if nobody changed it since it was snapshotted.
#
# Usage: update-issue-body.sh <issue-number> <snapshot-file> <new-body-file>
#
# <snapshot-file> is the description as it was when the readiness review read it
# (get-readiness.sh writes it as issue-body.md). If the description on GitHub differs from
# it now, nothing is changed: re-read the issue and apply the edits to the current text.
# Saves the description it replaces next to the new one, as <new-body-file>.replaced.
# GitHub also keeps every version in the issue's edit history. Uses the REST API only.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $(basename "$0") <issue-number> <snapshot-file> <new-body-file>" >&2
  exit 2
fi

n="$1"
snapshot="$2"
new="$3"
case "$n" in '' | *[!0-9]*) echo "error: issue number must be numeric, got '$n'" >&2; exit 2 ;; esac
[ -f "$snapshot" ] || { echo "error: no snapshot at $snapshot" >&2; exit 1; }
[ -s "$new" ] || { echo "error: '$new' is missing or empty" >&2; exit 1; }

current="$(mktemp)"
trap 'rm -f "$current"' EXIT
gh api "repos/{owner}/{repo}/issues/${n}" --jq '.body // ""' > "$current"

if ! cmp -s "$current" "$snapshot"; then
  echo "error: the description of issue #${n} changed since it was read; nothing was updated." >&2
  echo "Re-read it (get-readiness.sh), apply the accepted edits to the current text, and run this again." >&2
  exit 1
fi

cp "$current" "${new}.replaced"
gh api --method PATCH "repos/{owner}/{repo}/issues/${n}" -F "body=@${new}" --jq '"updated " + .html_url'
