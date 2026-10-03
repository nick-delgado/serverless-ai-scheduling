# Walking-skeleton page (#7)

A throwaway page that proves the path end to end:
1. Cognito SRP sign-in (`amazon-cognito-identity-js`, tokens in memory only).
2. `POST /api/chat` on the same origin, with `Authorization: <ID token>`.
3. The NDJSON reply rendered as each `text_delta` arrives (`fetch` + `ReadableStream`).

It's deliberately bare: no React, no typewriter smoothing, no session restore. The SPA shell (S5-01, #24) has no sign-in yet, so this page stays as the only way to exercise the deployed path. **Delete this folder** when the real login lands (S1-02, #25), along with `amazon-cognito-identity-js` in `apps/web/package.json` if the SPA uses Amplify Auth (ADR-005).

## Build and upload

Uploading SPA assets is a documented manual exception to "everything through CloudFormation" (ADR-003, `docs/runbooks/aws-setup.md`). From the repo root:

```bash
export AWS_PROFILE=sched-dev AWS_REGION=us-east-1 ENV=dev
ssm() { aws ssm get-parameter --name "/sched/$ENV/$1" --query Parameter.Value --output text; }

# Pool and client IDs are baked in at build time; they aren't secrets, but they stay out of the repo.
VITE_USER_POOL_ID=$(ssm auth/user-pool-id) VITE_SPA_CLIENT_ID=$(ssm auth/spa-client-id) \
  npx vite build --config apps/web/src/skeleton/vite.config.ts     # → apps/web/dist/skeleton/

BUCKET=$(ssm web/bucket-name) DIST=$(ssm web/distribution-id)
aws s3 sync apps/web/dist/skeleton/assets "s3://$BUCKET/assets" --delete --cache-control "public, max-age=31536000, immutable"
aws s3 cp apps/web/dist/skeleton/index.html "s3://$BUCKET/index.html" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html"

echo "https://$(ssm web/domain)/"
```

Sign in with the test user from `spikes/s2-streaming/.env` (git-ignored). The spike's README explains how to create one.

## Tearing down an ephemeral env

CloudFormation can't delete a non-empty bucket, so empty it before `scripts/teardown.sh <env>`:

```bash
aws s3 rm "s3://$(aws ssm get-parameter --name /sched/<env>/web/bucket-name --query Parameter.Value --output text)" --recursive
```
