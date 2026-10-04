#!/usr/bin/env bash
# Deploy sched-* workload stacks with SAM, in dependency order (ADR-003).
#
#   scripts/deploy.sh <data|auth|api|web|all> [env] [-- Key=Value ...]
#   scripts/deploy.sh all dev                                  # shared dev environment
#   scripts/deploy.sh all pr52                                 # ephemeral env: sched-pr52-* (tear down with teardown.sh)
#   scripts/deploy.sh data dev -- DeletionProtection=disabled  # overrides go only to templates that declare them
#
# Deploys the checkout this script lives in (repo_root below comes from the script's own path), so
# a worktree deploys its own branch. Every stack is tagged with the git branch and commit it came from.
#
# Runs as the SchedDeployer SSO profile (AWS_PROFILE, default sched-dev). CloudFormation itself
# acts through the sched-cfn-exec role from the bootstrap stack, so the caller only needs to
# drive CloudFormation, upload artifacts, and pass that one role.
set -euo pipefail

ORDER=(data auth api web)
# Long-lived environments: stateful resources stay deletion-protected, and teardown.sh refuses them.
# Keep in sync with scripts/teardown.sh and scripts/deploy-web.sh.
PROTECTED_ENVS=(dev demo)

target="${1:-}"
env="${2:-dev}"
shift $(( $# >= 2 ? 2 : $# ))
[[ "${1:-}" == "--" ]] && shift
extra_overrides=("$@")

usage() { echo "usage: $0 <data|auth|api|web|all> [env] [-- Key=Value ...]" >&2; exit 2; }
[[ -z "$target" ]] && usage
[[ "$env" =~ ^[a-z][a-z0-9-]{1,15}$ ]] || { echo "invalid env: $env (lowercase, 2-16 chars)" >&2; exit 2; }
if [[ "$target" == "all" ]]; then
  stacks=("${ORDER[@]}")
elif [[ " ${ORDER[*]} " == *" $target "* ]]; then
  stacks=("$target")
else
  usage
fi
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
