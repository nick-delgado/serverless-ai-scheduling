#!/usr/bin/env bash
# Deploy sched-* workload stacks with SAM, in dependency order (ADR-003).
#
#   scripts/deploy.sh <data|auth|api|web|all> [env] [-- extra "Key=Value" parameter overrides]
#   scripts/deploy.sh all dev
#   scripts/deploy.sh data dev -- DeletionProtection=disabled
#
# Runs as the SchedDeployer SSO profile (AWS_PROFILE, default sched-dev). CloudFormation itself
# acts through the sched-cfn-exec role from the bootstrap stack, so the caller only needs to
# drive CloudFormation, upload artifacts, and pass that one role.
set -euo pipefail

ORDER=(data auth api web)
target="${1:-}"
env="${2:-dev}"
shift $(( $# >= 2 ? 2 : $# ))
[[ "${1:-}" == "--" ]] && shift
extra_overrides=("$@")

usage() { echo "usage: $0 <data|auth|api|web|all> [env] [-- Key=Value ...]" >&2; exit 2; }
[[ -z "$target" ]] && usage
[[ "$env" =~ ^[a-z][a-z0-9-]{1,15}$ ]] || { echo "invalid env: $env" >&2; exit 2; }
if [[ "$target" == "all" ]]; then
  stacks=("${ORDER[@]}")
elif [[ " ${ORDER[*]} " == *" $target "* ]]; then
  stacks=("$target")
else
  usage
fi

export AWS_PROFILE="${AWS_PROFILE:-sched-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS credentials for profile '$AWS_PROFILE' are missing or expired. Run: aws sso login --profile $AWS_PROFILE" >&2
  exit 1
fi

ssm() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
role_arn="$(ssm /sched/bootstrap/cfn-exec-role-arn)"
bucket="$(ssm /sched/bootstrap/artifact-bucket)"

for stack in "${stacks[@]}"; do
  template="infra/stacks/${stack}.yaml"
  build_dir=".aws-sam/build-${stack}"
  stack_name="sched-${env}-${stack}"
  echo "==> ${stack_name}"

  sam validate --lint --template-file "$template" --region "$AWS_REGION"
  sam build --template-file "$template" --build-dir "$build_dir" --cached --cache-dir ".aws-sam/cache-${stack}" >/dev/null

  sam deploy \
    --config-file "$repo_root/infra/samconfig.toml" --config-env "$stack" \
    --template-file "$build_dir/template.yaml" \
    --stack-name "$stack_name" \
    --role-arn "$role_arn" \
    --s3-bucket "$bucket" --s3-prefix "$stack_name" \
    --parameter-overrides "Env=${env}" ${extra_overrides[@]+"${extra_overrides[@]}"} \
    --tags "project=sched" "env=${env}" "stack=${stack}" \
    --region "$AWS_REGION"
done
