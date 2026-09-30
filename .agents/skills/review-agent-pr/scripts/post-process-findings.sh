#!/usr/bin/env bash
# Post a review's process findings (causes and proposals) as a comment on the repository's
# tracking issue, creating the issue on first use. If this user already posted the process
# findings for the same PR, that comment is updated instead.
#
# Usage: post-process-findings.sh <pr-number> <process-file>
# Run from inside a clone of the PR's repository. Requires an authenticated gh.

set -euo pipefail

LABEL='agent-process'
ISSUE_TITLE='Agent process findings'
MAX_CHARS=65536

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <pr-number> <process-file>" >&2
  exit 2
fi

pr="$1"
file="$2"

case "$pr" in
  '' | *[!0-9]*)
    echo "error: PR number must be numeric, got '$pr'" >&2
    exit 2
    ;;
esac

marker="<!-- agent-pr-review:process pr=${pr} -->"

if [ ! -s "$file" ]; then
  echo "error: process file '$file' is missing or empty" >&2
  exit 1
fi

if [ "$(head -n 1 "$file")" != "$marker" ]; then
  echo "error: the first line of the file must be: $marker" >&2
  exit 1
fi

chars="$(LC_ALL=en_US.UTF-8 wc -m < "$file" | tr -d '[:space:]')"
if [ "$chars" -gt "$MAX_CHARS" ]; then
  echo "error: file is $chars characters; GitHub allows $MAX_CHARS per comment." >&2
  exit 1
fi

# The tracking issue is the oldest open issue carrying the label.
issue="$(gh issue list --label "$LABEL" --state open --limit 100 --json number --jq 'map(.number) | min // empty')"

if [ -z "$issue" ]; then
  gh label create "$LABEL" --force \
    --description "Why AI agents produced review findings, and proposed fixes to docs, skills and guardrails" \
    --color "5319E7" > /dev/null
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' EXIT
  cat > "$body_file" <<'EOF'
<!-- agent-pr-review:process-log -->
This issue is the log of process findings from reviews of agent-authored pull requests.

Each comment covers one reviewed PR: the inferred cause of each finding, the patterns across findings, and proposed changes to the docs, skills, prompts, specs and guardrails of this project.

Nothing here is applied automatically. The `improve-agent-process` skill reads this log across reviews and opens one batched pull request with the changes worth making.
EOF
  url="$(gh issue create --title "$ISSUE_TITLE" --label "$LABEL" --body-file "$body_file")"
  issue="${url##*/}"
  echo "created tracking issue $url"
fi

login="$(gh api user --jq '.login')"

existing="$(
  gh api --paginate "repos/{owner}/{repo}/issues/${issue}/comments" \
    --jq ".[] | select(.user.login == \"${login}\") | select(.body | startswith(\"${marker}\")) | .id" |
    tail -n 1
)"

if [ -n "$existing" ]; then
  gh api --method PATCH "repos/{owner}/{repo}/issues/comments/${existing}" \
    -F "body=@${file}" --jq '"updated " + .html_url'
else
  gh api --method POST "repos/{owner}/{repo}/issues/${issue}/comments" \
    -F "body=@${file}" --jq '"created " + .html_url'
fi
