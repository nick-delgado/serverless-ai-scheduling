# Spike S-2: streaming through CloudFront → REST API → Lambda (#7)

Throwaway measurement code that feeds [ADR-007](../../docs/adr/0007-chat-transport.md). The thing it measures is the deployed walking skeleton: `services/api/src/handlers/chat-skeleton.ts` behind `infra/stacks/api.yaml` and `infra/stacks/web.yaml`.

**The question.** Does an NDJSON reply from a response-streaming Lambda reach the client *incrementally* through API Gateway REST (`responseTransferMode: STREAM`) and CloudFront, or does some hop buffer it? And what are time to first byte, time to first `text_delta`, and total time?

**What `measure.ts` does.**
1. Signs in the skeleton test user with Cognito SRP (the only flow the app client allows) and gets an ID token.
2. Sends the same ~120-word prompt `--runs` times to each target, round-robin: CloudFront (`https://<distribution>/api/chat`) and the direct execute-api URL (`/<stage>/api/chat`). Calls are at least `--pace-ms` apart (minimum 8 s): the account's Bedrock quota is 10 requests/min, shared.
3. For each request it records:
   - time to response headers, first body chunk, first `text_delta`, last `text_delta`, and stream end;
   - the arrival time, size, and event count of **every** network chunk;
   - selected response headers (`content-encoding`, `x-cache`, …).
4. Negative paths on both targets: no token, malformed token, bad body with a valid token. None of these reach Bedrock.
5. Joins the Lambda's own `chat turn` log lines by API request ID, to split model time from transport time.

Results go to `results/raw-<timestamp>.json` and `results/summary-<timestamp>.md`, with endpoint names and account IDs redacted. `results/notes-2026-09-29.md` has the cold-start `curl -N` transcript and the browser check.

## Running it

The test user's password lives only in a git-ignored `spikes/s2-streaming/.env`:

```bash
SKELETON_USERNAME=skeleton-tester
SKELETON_PASSWORD=...
```

To (re)create the user in an env's pool (a documented manual exception, ADR-005):

```bash
export AWS_PROFILE=sched-dev AWS_REGION=us-east-1
POOL=$(aws ssm get-parameter --name /sched/dev/auth/user-pool-id --query Parameter.Value --output text)
PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 28)Aa9"
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username skeleton-tester --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username skeleton-tester --password "$PW" --permanent
umask 077; printf 'SKELETON_USERNAME=skeleton-tester\nSKELETON_PASSWORD=%s\n' "$PW" > spikes/s2-streaming/.env
```

Then, from the repo root:

```bash
AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx spikes/s2-streaming/measure.ts --runs 10 --pace-ms 8000
```

A run of 10 per target makes 20 Bedrock calls (Sonnet 4.6, about 100 input and 150 output tokens each; a few cents in total) and takes about four minutes.

For an ad-hoc `curl -N` check (the token is valid for 60 minutes; never paste it anywhere):

```bash
TOKEN=$(AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx spikes/s2-streaming/token.ts)
curl -N -X POST "https://$(aws ssm get-parameter --name /sched/dev/web/domain --query Parameter.Value --output text)/api/chat" \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"clientMessageId":"5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c","text":"Hello!"}'
```
