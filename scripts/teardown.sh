#!/usr/bin/env bash
# Delete an EPHEMERAL environment's stacks in reverse dependency order (web → api → auth → data),
# including its table data and user pool. Refuses protected long-lived envs (dev, demo): tearing
# those down is a manual, Nick-approved procedure (sam-deploy skill).
#
#   scripts/teardown.sh <env>          # asks you to type the env name to confirm (closed stdin aborts)
#   scripts/teardown.sh <env> --yes    # non-interactive (agents: only after Nick has approved)
#
# Any other second argument (a typo such as --yse, or an empty one) or a third argument is refused with the usage
# line and exit 2, before any AWS call.
set -euo pipefail

ORDER_REVERSED=(web api auth data)
PROTECTED_ENVS=(dev demo) # keep in sync with scripts/deploy.sh and scripts/deploy-web.sh

usage() { echo "usage: $0 <env> [--yes]" >&2; exit 2; }
env="${1:-}"
assume_yes="${2:-}"
[[ "$env" =~ ^[a-z][a-z0-9-]{1,15}$ ]] || usage
[[ $# -le 2 ]] || usage
[[ $# -lt 2 || "$assume_yes" == "--yes" ]] || usage
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

echo "This permanently deletes: ${existing[*]} (including any table data, users, and site files)."
if [[ "$assume_yes" != "--yes" ]]; then
  # read fails at end of input, even after a partial line: no confirmation was given.
  if ! read -r -p "Type the env name ('${env}') to confirm: " answer; then
    echo "aborted: no confirmation given (stdin closed)"
    exit 1
  fi
  [[ "$answer" == "$env" ]] || { echo "aborted"; exit 1; }
fi

role_arn="$(aws ssm get-parameter --name /sched/bootstrap/cfn-exec-role-arn --query Parameter.Value --output text)"

# CloudFormation can't delete a bucket that still has objects, so empty the site bucket before its
# stack goes. The bucket isn't versioned (infra/stacks/web.yaml); if it ever is, versions must be
# deleted too, which also needs s3:ListBucketVersions / s3:DeleteObjectVersion for SchedDeployer.
# Only a missing parameter means "no bucket". Any other failed read (throttling, access) stops the teardown
# with the CLI's error, because the web stack's delete would fail on a bucket left full (as deploy-web.sh, PR #132).
empty_site_bucket() {
  local param="/sched/${env}/web/bucket-name" bucket status=0
  # stderr joins stdout: on failure stdout is empty, so this holds only the CLI's error. (Had a successful read
  # printed a warning, it would join the name and fail the bucket check below, which stops before any delete.)
  bucket="$(aws ssm get-parameter --name "$param" --query Parameter.Value --output text 2>&1)" || status=$?
  if [[ $status -ne 0 ]]; then
    [[ "$bucket" == *ParameterNotFound* ]] && return 0
    printf '%s\n' "$bucket" >&2
    echo "could not read ${param}; stopping before any delete." >&2
    exit 1
  fi
  [[ -z "$bucket" || "$bucket" == "None" ]] && return 0
  if [[ "$bucket" != sched-"${env}"-web-* ]]; then
    echo "refusing to empty unexpected bucket '${bucket}' for env '${env}'" >&2
    exit 1
  fi
  echo "==> emptying s3://${bucket}"
  aws s3 rm "s3://${bucket}" --recursive --only-show-errors
}
for name in "${existing[@]}"; do
  [[ "$name" == "sched-${env}-web" ]] && empty_site_bucket
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
