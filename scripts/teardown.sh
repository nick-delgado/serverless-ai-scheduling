#!/usr/bin/env bash
# Delete an EPHEMERAL environment's stacks in reverse dependency order (web → api → auth → data),
# including its table data and user pool. Refuses protected long-lived envs (dev, demo): tearing
# those down is a manual, Nick-approved procedure (sam-deploy skill).
#
#   scripts/teardown.sh <env>          # asks you to type the env name to confirm
#   scripts/teardown.sh <env> --yes    # non-interactive (agents: only after Nick has approved)
set -euo pipefail

ORDER_REVERSED=(web api auth data)
PROTECTED_ENVS=(dev demo) # keep in sync with scripts/deploy.sh

env="${1:-}"
assume_yes="${2:-}"
[[ "$env" =~ ^[a-z][a-z0-9-]{1,15}$ ]] || { echo "usage: $0 <env> [--yes]" >&2; exit 2; }
if [[ " ${PROTECTED_ENVS[*]} " == *" $env "* ]]; then
  echo "refusing: '$env' is a protected environment. See the sam-deploy skill's teardown section." >&2
  exit 1
fi

export AWS_PROFILE="${AWS_PROFILE:-sched-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS credentials for profile '$AWS_PROFILE' are missing or expired. Run: aws sso login --profile $AWS_PROFILE" >&2
  exit 1
fi

existing=()
for stack in "${ORDER_REVERSED[@]}"; do
  name="sched-${env}-${stack}"
  if aws cloudformation describe-stacks --stack-name "$name" >/dev/null 2>&1; then existing+=("$name"); fi
done
if [[ ${#existing[@]} -eq 0 ]]; then
  echo "nothing to delete: no sched-${env}-* stacks found"
  exit 0
fi

echo "This permanently deletes: ${existing[*]} (including any table data and users)."
if [[ "$assume_yes" != "--yes" ]]; then
  read -r -p "Type the env name ('${env}') to confirm: " answer
  [[ "$answer" == "$env" ]] || { echo "aborted"; exit 1; }
fi

role_arn="$(aws ssm get-parameter --name /sched/bootstrap/cfn-exec-role-arn --query Parameter.Value --output text)"
for name in "${existing[@]}"; do
  echo "==> deleting ${name}"
  aws cloudformation delete-stack --stack-name "$name" --role-arn "$role_arn"
  if ! aws cloudformation wait stack-delete-complete --stack-name "$name"; then
    echo "delete failed for ${name}. If deletion protection is on, redeploy it with" \
         "'scripts/deploy.sh <stack> ${env} -- DeletionProtection=disabled' and retry." >&2
    aws cloudformation describe-stack-events --stack-name "$name" \
      --query 'StackEvents[?contains(ResourceStatus, `FAILED`)].[LogicalResourceId,ResourceStatusReason]' --output table >&2 || true
    exit 1
  fi
done
echo "deleted: ${existing[*]}"
