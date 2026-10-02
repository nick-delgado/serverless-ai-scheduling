#!/usr/bin/env bash
# Post a review's process findings (causes and proposals) as a comment on the repository's
# tracking issue, creating the issue on first use. There is one comment per review round:
# if this user already posted the process findings for the same PR and reviewed commit,
# that comment is updated; a re-review of a new commit adds a new comment, so the causes
# found in earlier rounds stay in the log.
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


if [ ! -s "$file" ]; then
  echo "error: process file '$file' is missing or empty" >&2
  exit 1
fi

marker="$(head -n 1 "$file")"
if ! printf '%s\n' "$marker" | grep -qE "^<!-- agent-pr-review:process pr=${pr} sha=[0-9a-f]{7,40} -->\$"; then
  echo "error: the first line of the file must be: <!-- agent-pr-review:process pr=${pr} sha=<reviewed commit> -->" >&2
  exit 1
fi

chars="$(LC_ALL=en_US.UTF-8 wc -m < "$file" | tr -d '[:space:]')"
if [ "$chars" -gt "$MAX_CHARS" ]; then
  echo "error: file is $chars characters; GitHub allows $MAX_CHARS per comment." >&2
  exit 1
fi

# The tracking issue is the oldest open issue carrying the label.
issue="$(
  gh api --paginate "repos/{owner}/{repo}/issues?labels=${LABEL}&state=open&per_page=100" \
    --jq '.[] | select(.pull_request | not) | .number' | sort -n | head -n 1
)"

if [ -z "$issue" ]; then
  # Create the label unless it exists (the API answers 422 when it does).
  gh api --method POST "repos/{owner}/{repo}/labels" -f name="$LABEL" -f color="5319E7" \
    -f description="Why AI agents produced review findings, and proposed fixes to docs, skills and guardrails" \
    > /dev/null 2>&1 || true
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' EXIT
  cat > "$body_file" <<'EOF'
<!-- agent-pr-review:process-log -->
This issue is the log of process findings from reviews of agent-authored pull requests.

Each comment covers one reviewed PR: the inferred cause of each finding, the patterns across findings, and proposed changes to the docs, skills, prompts, specs and guardrails of this project.

Nothing here is applied automatically. The `improve-agent-process` skill reads this log across reviews and opens one batched pull request with the changes worth making.
EOF
  url="$(gh api --method POST "repos/{owner}/{repo}/issues" -f title="$ISSUE_TITLE" \
    -f "labels[]=$LABEL" -F "body=@${body_file}" --jq '.html_url')"
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
