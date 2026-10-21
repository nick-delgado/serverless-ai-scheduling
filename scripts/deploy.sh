#!/usr/bin/env bash
# Deploy sched-* workload stacks with SAM, in dependency order (ADR-003).
#
#   scripts/deploy.sh <data|auth|api|web|all> [env] [-- Key=Value ...]
#   scripts/deploy.sh all dev                                  # shared dev environment
#   scripts/deploy.sh all pr52                                 # ephemeral env: sched-pr52-* (tear down with teardown.sh)
#   scripts/deploy.sh data dev -- DeletionProtection=disabled  # overrides go only to templates that declare them
#
# The api stack also takes the escalation email's SES identity from SES_SENDER / SES_STAFF_RECIPIENT
# (environment or the git-ignored .env); dev and demo refuse to deploy it without them, and any env refuses
# a value that spans lines (see "the escalation email's SES identity" below).
#
# The api stack also takes the Cloudflare Turnstile secret key from TURNSTILE_SECRET (environment or .env), a NoEcho
# parameter like the SES addresses. Where the reviewer access page (#357) is on (`demo`, or `-- RequestAccess=on`),
# deploying refuses without it and without `-- TurnstileExpectedHostname=<domain>`; `RequestAccess=on` is refused for
# dev and e2e (see "the reviewer access page" below).
#
# Arguments: the target is one stack name or `all`, exactly; anything after the env must start with `--`.
#
# Deploys the checkout this script lives in (repo_root below comes from the script's own path), so
# a worktree deploys its own branch. Every stack is tagged with the git branch and commit it came from.
#
# Runs as the SchedDeployer SSO profile (AWS_PROFILE, default sched-dev), or in .github/workflows/deploy.yml as the
# sched-github-deploy role, whose credentials come from the environment (#41). CloudFormation itself
# acts through the sched-cfn-exec role from the bootstrap stack, so the caller only needs to
# drive CloudFormation, upload artifacts, and pass that one role.
set -euo pipefail

ORDER=(data auth api web)
# Long-lived environments: stateful resources stay deletion-protected, and teardown.sh refuses them.
# Keep in sync with scripts/teardown.sh and scripts/deploy-web.sh.
PROTECTED_ENVS=(dev demo)

usage() { echo "usage: $0 <data|auth|api|web|all> [env] [-- Key=Value ...]" >&2; exit 2; }
target="${1:-}"
env="${2:-dev}"
shift $(( $# >= 2 ? 2 : $# ))
[[ "$env" =~ ^[a-z][a-z0-9-]{1,15}$ ]] || { echo "invalid env: $env (lowercase, 2-16 chars)" >&2; exit 2; }
# Overrides come only after `--`: `deploy.sh data pr7 DeletionProtection=enabled` is refused.
if [[ $# -gt 0 ]]; then
  [[ "$1" == "--" ]] || usage
  shift
fi
extra_overrides=("$@")
# The target must equal one stack name (or `all`): "data auth" or " data" is refused here, before any AWS call.
stacks=()
if [[ "$target" == "all" ]]; then
  stacks=("${ORDER[@]}")
else
  for stack in "${ORDER[@]}"; do
    if [[ "$target" == "$stack" ]]; then stacks=("$stack"); fi
  done
fi
[[ ${#stacks[@]} -gt 0 ]] || usage
is_protected=false
[[ " ${PROTECTED_ENVS[*]} " == *" $env "* ]] && is_protected=true

export AWS_PROFILE="${AWS_PROFILE:-sched-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS credentials for profile '$AWS_PROFILE' are missing or expired. Run: aws sso login --profile $AWS_PROFILE" >&2
  exit 1
fi

# --- provenance ------------------------------------------------------------------------------
tag_safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.:/=+@-' '_'; }
git_branch="$(tag_safe "$(git rev-parse --abbrev-ref HEAD)")"
git_commit="$(git rev-parse --short=12 HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then git_commit="${git_commit}-dirty"; fi

# Ephemeral envs default to DeletionProtection=disabled so teardown.sh can remove them cleanly.
if ! $is_protected && [[ " ${extra_overrides[*]-} " != *" DeletionProtection="* ]]; then
  extra_overrides+=("DeletionProtection=disabled")
fi

# --- the escalation email's SES identity (api stack, #35) --------------------------------------
# SES_SENDER and SES_STAFF_RECIPIENT are never committed (public repo): they come from the environment, or
# else from the git-ignored .env of this checkout or of the main checkout (worktrees share that one). They
# go to the api stack as NoEcho parameters, which SAM prints as *****. Never echo them here.
#
# A non-empty environment variable wins; otherwise the first non-empty value of the worktree's .env, then of the
# main checkout's. A .env is parsed by Node's util.parseEnv, the parser scripts/retry-escalations.ts uses, so the
# two read a file the same way (that script still differs in which value it picks: it keeps an environment
# variable set to "" and reads only the repo root's .env). Read as the bare value: double or single quotes, CRLF
# line endings, an inline `# comment`, an `export ` prefix, spaces around `=`; the last line for a key wins. An
# unmatched quote on one line is kept as written (`"a@example.com'` reaches SAM as is). A value that spans lines,
# which is what an unmatched quote becomes when a later line has the same quote, is refused.
main_checkout="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
# The value of $1 from the first .env that has a non-empty one; a file is read only if it exists.
# scripts/deploy-web.sh keeps a copy of this function (it reads TURNSTILE_SITE_KEY): change both together.
env_file_value() {
  local key="$1" file val=""
  for file in "$repo_root/.env" "$main_checkout/.env"; do
    [[ -f "$file" ]] || continue
    val="$(node -e 'const { parseEnv } = require("node:util");
      const vars = parseEnv(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(vars[process.argv[2]] ?? "");' "$file" "$key")" || exit 1
    [[ -n "$val" ]] && break
  done
  printf '%s' "$val"
}
ses_overrides=()
turnstile_secret=""
if [[ " ${stacks[*]} " == *" api "* ]]; then
  ses_sender="${SES_SENDER:-$(env_file_value SES_SENDER)}"
  ses_recipient="${SES_STAFF_RECIPIENT:-$(env_file_value SES_STAFF_RECIPIENT)}"
  # The Turnstile secret (the reviewer access page, below) is read here so one check covers all three values.
  turnstile_secret="${TURNSTILE_SECRET:-$(env_file_value TURNSTILE_SECRET)}"
  multiline=()
  [[ "$ses_sender" == *[$'\n\r']* ]] && multiline+=(SES_SENDER)
  [[ "$ses_recipient" == *[$'\n\r']* ]] && multiline+=(SES_STAFF_RECIPIENT)
  [[ "$turnstile_secret" == *[$'\n\r']* ]] && multiline+=(TURNSTILE_SECRET)
  if [[ ${#multiline[@]} -gt 0 ]]; then
    echo "${multiline[*]} spans more than one line (in .env, an unmatched quote may have swallowed the" \
         "lines after it); fix it before deploying the api stack." >&2
    exit 1
  fi
  if [[ -n "$ses_sender" && -n "$ses_recipient" ]]; then
    ses_overrides=("SesSender=${ses_sender}" "SesStaffRecipient=${ses_recipient}")
  elif $is_protected; then
    echo "SES_SENDER and SES_STAFF_RECIPIENT must be set (environment or .env, see .env.example) to deploy" \
         "the api stack to '${env}': without them the chat function loses its escalation email." >&2
    exit 1
  else
    echo "note: SES_SENDER/SES_STAFF_RECIPIENT not set; '${env}' gets no escalation email (notifications FAILED)." >&2
  fi
fi

# --- the reviewer access page (api stack, #357) -----------------------------------------------------
# TURNSTILE_SECRET is Cloudflare Turnstile's secret key (r1/Q-1 (a)): never committed, read with the SES values above
# (the environment, then this checkout's .env, then the main checkout's), passed as the NoEcho parameter TurnstileSecret
# when set, and never echoed. The page is on in `demo` (the template's `Env` clause, r1/Q-4 (a), now that the expiry
# job exists) and wherever `RequestAccess=on` is passed. `dev` and `e2e` stay off: `RequestAccess=on` is refused there.
# The rule "the page is on in demo or with RequestAccess=on" is the template's condition `RequestAccessOn` (infra/stacks/api.yaml);
# change both together. On a demo deploy and on any deploy that passes RequestAccess=on, the secret and TurnstileExpectedHostname (the hostname Cloudflare must report; decision
# 97fb801/SPEC-3 (b) on PR #366) must both be given, so the bot check can't be deployed half-configured.
ACCESS_REFUSED_ENVS=(dev e2e)
access_overrides=()
override_value() {
  local kv
  for kv in ${extra_overrides[@]+"${extra_overrides[@]}"}; do
    if [[ "$kv" == "$1="* ]]; then printf '%s' "${kv#*=}"; return; fi
  done
}
if [[ " ${stacks[*]} " == *" api "* ]]; then
  access_requested=false
  [[ "$(override_value RequestAccess)" == "on" ]] && access_requested=true
  if $access_requested && [[ " ${ACCESS_REFUSED_ENVS[*]} " == *" $env "* ]]; then
    echo "refusing RequestAccess=on for '${env}': the request page stays off on dev and e2e; only demo and an" \
         "ephemeral env (scripts/deploy.sh all <name>) turn it on." >&2
    exit 1
  fi
  if $access_requested || [[ "$env" == "demo" ]]; then
    if [[ -z "$turnstile_secret" ]]; then
      echo "TURNSTILE_SECRET must be set (environment or .env, see .env.example) to deploy the api stack with" \
           "the request page on (RequestAccess=on, or the demo env): the request function can't verify the bot" \
           "check without it." >&2
      exit 1
    fi
    expected_hostname="$(override_value TurnstileExpectedHostname)"
    if [[ ! "$expected_hostname" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
      echo "TurnstileExpectedHostname must be passed as one hostname (-- TurnstileExpectedHostname=<domain>) to" \
           "deploy the api stack with the request page on (RequestAccess=on, or the demo env): without it the" \
           "bot check accepts a token issued on any hostname. See docs/runbooks/deploy-env.md, 'Reviewer access'." >&2
      exit 1
    fi
  fi
  [[ -n "$turnstile_secret" ]] && access_overrides=("TurnstileSecret=${turnstile_secret}")
fi

echo "Deploying ${stacks[*]} to env '${env}' from ${git_branch}@${git_commit} (${repo_root})"
if $is_protected && [[ "$git_branch" != "main" ]]; then
  echo "note: '${env}' is shared; this deploys an unmerged branch. Deploy only the stacks your issue owns," \
       "or use an ephemeral env (scripts/deploy.sh all <name>). See the sam-deploy skill." >&2
fi

ssm() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
role_arn="$(ssm /sched/bootstrap/cfn-exec-role-arn)"
bucket="$(ssm /sched/bootstrap/artifact-bucket)"

# Top-level parameter names declared by a template (two-space indented keys under "Parameters:").
template_params() { awk '/^Parameters:/{p=1;next} /^[^ #]/{p=0} p && /^  [A-Za-z0-9]+:/{sub(/^  /,""); sub(/:.*/,""); print}' "$1"; }

for stack in "${stacks[@]}"; do
  template="infra/stacks/${stack}.yaml"
  build_dir=".aws-sam/build-${stack}"
  stack_name="sched-${env}-${stack}"
  echo "==> ${stack_name}"

  # CloudFormation rejects overrides for parameters a template doesn't declare, so filter per template.
  declared=" $(template_params "$template" | tr '\n' ' ') "
  overrides=("Env=${env}")
  for kv in ${extra_overrides[@]+"${extra_overrides[@]}"}; do
    [[ "$declared" == *" ${kv%%=*} "* ]] && overrides+=("$kv")
  done
  [[ "$stack" == "api" ]] && overrides+=(${ses_overrides[@]+"${ses_overrides[@]}"} ${access_overrides[@]+"${access_overrides[@]}"})

  sam validate --lint --template-file "$template" --region "$AWS_REGION"
  sam build --template-file "$template" --build-dir "$build_dir" --cached --cache-dir ".aws-sam/cache-${stack}" >/dev/null

  sam deploy \
    --config-file "$repo_root/infra/samconfig.toml" --config-env "$stack" \
    --template-file "$build_dir/template.yaml" \
    --stack-name "$stack_name" \
    --role-arn "$role_arn" \
    --s3-bucket "$bucket" --s3-prefix "$stack_name" \
    --parameter-overrides "${overrides[@]}" \
    --tags "project=sched" "env=${env}" "stack=${stack}" "git-branch=${git_branch}" "git-commit=${git_commit}" \
    --region "$AWS_REGION"
done
