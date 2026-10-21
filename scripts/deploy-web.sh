#!/usr/bin/env bash
# Build the SPA and publish it to an env's web stack: sync apps/web/dist/ to the site bucket, then
# invalidate the CloudFront distribution (#100). This is the documented CLI exception for SPA assets
# (docs/runbooks/aws-setup.md, ADR-003); the bucket and distribution themselves come from
# infra/stacks/web.yaml, deployed with scripts/deploy.sh.
#
#   scripts/deploy-web.sh <env>              # build, print the plan, sync, invalidate, wait
#   scripts/deploy-web.sh <env> --dry-run    # build and print the plan; change nothing
#
# Everything env-specific comes from SSM, never from this file:
#   /sched/<env>/auth/user-pool-id      → VITE_USER_POOL_ID      (baked into the build, ADR-005)
#   /sched/<env>/auth/spa-client-id     → VITE_SPA_CLIENT_ID
#   /sched/<env>/auth/identity-pool-id  → VITE_IDENTITY_POOL_ID  (voice, #29)
#   /sched/<env>/web/bucket-name, /sched/<env>/web/distribution-id, /sched/<env>/web/domain
# A missing parameter stops the script before it builds.
#
# The reviewer access page (#357, r1/Q-4 (a)): /sched/<env>/api/request-access ("on" or "off") → VITE_REQUEST_ACCESS.
# That one parameter may be missing (an env whose api stack predates the page): missing reads as off. When it is on,
# the page's public Turnstile site key comes from TURNSTILE_SITE_KEY (the environment, then the checkout's .env, then
# the main checkout's, as deploy.sh reads the SES values) → VITE_TURNSTILE_SITE_KEY, and the script refuses to build
# without it. The site key is public (it ships in the bundle) but stays out of the repo, so each env can have its own.
#
# Caching: hashed files under assets/ are immutable for a year; every other file (index.html) is
# `no-cache`, so browsers revalidate it and pick up new asset names. The upload order keeps the live
# site whole: new assets first, then index.html, then stale files are deleted (--delete), then the
# invalidation. Like deploy.sh it publishes the checkout it lives in, as SchedDeployer (AWS_PROFILE,
# default sched-dev) or, in .github/workflows/deploy.yml, as the sched-github-deploy role (#41); no CloudFormation
# and no exec role are involved. It refuses a dirty working tree.
set -euo pipefail

# Keep in sync with scripts/deploy.sh and scripts/teardown.sh.
PROTECTED_ENVS=(dev demo)
ASSETS_CACHE_CONTROL="public, max-age=31536000, immutable"
ROOT_CACHE_CONTROL="no-cache"

usage() { echo "usage: $0 <env> [--dry-run]" >&2; exit 2; }
env="${1:-}"
mode="${2:-}"
[[ -z "$env" || $# -gt 2 ]] && usage
[[ -z "$mode" || "$mode" == "--dry-run" ]] || usage
[[ "$env" =~ ^[a-z][a-z0-9-]{1,15}$ ]] || { echo "invalid env: $env (lowercase, 2-16 chars)" >&2; exit 2; }
dry_run=false
[[ "$mode" == "--dry-run" ]] && dry_run=true
is_protected=false
[[ " ${PROTECTED_ENVS[*]} " == *" $env "* ]] && is_protected=true

export AWS_PROFILE="${AWS_PROFILE:-sched-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
dist="apps/web/dist"

# --- refusals that need no AWS ----------------------------------------------------------------
# A dirty tree (including untracked files) would publish code no commit describes.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing: the working tree has uncommitted changes; commit or remove them first:" >&2
  git status --short >&2
  exit 1
fi
git_branch="$(git rev-parse --abbrev-ref HEAD)"
git_commit="$(git rev-parse --short=12 HEAD)"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS credentials for profile '$AWS_PROFILE' are missing or expired. Run: aws sso login --profile $AWS_PROFILE" >&2
  exit 1
fi

echo "Publishing the SPA to env '${env}' from ${git_branch}@${git_commit} (${repo_root})"
if $is_protected && [[ "$git_branch" != "main" ]]; then
  echo "note: '${env}' is shared; this publishes an unmerged branch's SPA over it. Prefer an ephemeral env" \
       "(scripts/deploy.sh all <name>, then scripts/deploy-web.sh <name>). See the sam-deploy skill." >&2
fi

# --- configuration from SSM, all of it before the build -----------------------------------------
param() { # <name> → its value, or nothing when the parameter is missing or unreadable (the CLI's error stays visible)
  local value
  value="$(aws ssm get-parameter --name "$1" --query Parameter.Value --output text || true)"
  [[ "$value" == "None" ]] && value=""
  printf '%s' "$value"
}
user_pool_id="$(param "/sched/${env}/auth/user-pool-id")"
spa_client_id="$(param "/sched/${env}/auth/spa-client-id")"
identity_pool_id="$(param "/sched/${env}/auth/identity-pool-id")"
bucket="$(param "/sched/${env}/web/bucket-name")"
distribution_id="$(param "/sched/${env}/web/distribution-id")"
domain="$(param "/sched/${env}/web/domain")"
# The page switch: a missing or unreadable parameter is "off" (the CLI's error stays visible, as for the others).
request_access="$(param "/sched/${env}/api/request-access")"
[[ "$request_access" == "on" ]] || request_access="off"
# The value of $1 from the environment, else the first .env (this checkout's, then the main checkout's) that has a
# non-empty one. A copy of the function in scripts/deploy.sh, which reads the SES values and the Turnstile secret with
# it: change both together.
main_checkout="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
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
turnstile_site_key=""
if [[ "$request_access" == "on" ]]; then
  turnstile_site_key="${TURNSTILE_SITE_KEY:-$(env_file_value TURNSTILE_SITE_KEY)}"
  if [[ -z "$turnstile_site_key" || "$turnstile_site_key" == *[$'\n\r']* ]]; then
    echo "refusing: '${env}' has the request page on, so TURNSTILE_SITE_KEY must be set to one line (environment or" \
         ".env, see .env.example): the page can't show the bot check without it" >&2
    exit 1
  fi
fi
missing=()
for pair in "auth/user-pool-id=$user_pool_id" "auth/spa-client-id=$spa_client_id" \
            "auth/identity-pool-id=$identity_pool_id" "web/bucket-name=$bucket" \
            "web/distribution-id=$distribution_id" "web/domain=$domain"; do
  [[ -n "${pair#*=}" ]] || missing+=("/sched/${env}/${pair%%=*}")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "refusing: missing SSM parameters (deploy the auth and web stacks for '${env}' first):" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi
# The same guard as teardown.sh: only ever write to this env's own site bucket.
if [[ "$bucket" != sched-"${env}"-web-* ]]; then
  echo "refusing: unexpected bucket '${bucket}' for env '${env}' (expected sched-${env}-web-*)" >&2
  exit 1
fi

# --- build -------------------------------------------------------------------------------------
echo "==> building apps/web with the '${env}' Cognito settings"
rm -rf "$dist"
VITE_USER_POOL_ID="$user_pool_id" VITE_SPA_CLIENT_ID="$spa_client_id" VITE_IDENTITY_POOL_ID="$identity_pool_id" \
  VITE_REQUEST_ACCESS="$request_access" VITE_TURNSTILE_SITE_KEY="$turnstile_site_key" \
  npm run build -w apps/web

if [[ ! -f "$dist/index.html" ]] || [[ -z "$(find "$dist/assets" -type f 2>/dev/null | head -n 1)" ]]; then
  echo "refusing: the build produced no ${dist}/index.html or no files under ${dist}/assets/" >&2
  exit 1
fi
# The IDs reach the bundle only through Vite's env. A build that lost the user pool ID would sign
# nobody in; one that lost the Identity Pool ID would sign patients in but quietly take voice off.
if ! grep -rqF -- "$user_pool_id" "$dist/assets"; then
  echo "refusing: the built assets don't contain the '${env}' user pool ID; VITE_USER_POOL_ID didn't reach the build" >&2
  exit 1
fi
if ! grep -rqF -- "$identity_pool_id" "$dist/assets"; then
  echo "refusing: the built assets don't contain the '${env}' Identity Pool ID; VITE_IDENTITY_POOL_ID didn't reach the build" >&2
  exit 1
fi

if [[ "$request_access" == "on" ]] && ! grep -rqF -- "$turnstile_site_key" "$dist/assets"; then
  echo "refusing: the built assets don't contain the Turnstile site key; VITE_TURNSTILE_SITE_KEY didn't reach the build" >&2
  exit 1
fi

# --- plan --------------------------------------------------------------------------------------
target="s3://${bucket}"
echo "==> plan for ${target} (assets/* → '${ASSETS_CACHE_CONTROL}'; everything else → '${ROOT_CACHE_CONTROL}')"
aws s3 sync "$dist" "$target" --delete --dryrun
if $dry_run; then
  echo "dry run: nothing uploaded, deleted or invalidated"
  exit 0
fi

# --- publish -----------------------------------------------------------------------------------
echo "==> uploading assets/"
aws s3 sync "$dist/assets" "${target}/assets" --cache-control "$ASSETS_CACHE_CONTROL" --only-show-errors
echo "==> uploading index.html and other root files"
aws s3 sync "$dist" "$target" --exclude "assets/*" --delete --cache-control "$ROOT_CACHE_CONTROL" \
  --metadata "git-commit=${git_commit}" --only-show-errors
echo "==> deleting stale assets"
aws s3 sync "$dist/assets" "${target}/assets" --delete --cache-control "$ASSETS_CACHE_CONTROL" --only-show-errors

echo "==> invalidating CloudFront"
invalidation_id="$(aws cloudfront create-invalidation --distribution-id "$distribution_id" --paths "/*" \
  --query Invalidation.Id --output text)"
echo "invalidation ${invalidation_id}; waiting for it to complete"
aws cloudfront wait invalidation-completed --distribution-id "$distribution_id" --id "$invalidation_id"
echo "published ${git_branch}@${git_commit} to https://${domain}/ (invalidation ${invalidation_id})"
