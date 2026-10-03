# 2026-10-03 — Restore shows what the patient saw: one bubble per turn, and no tool blocks

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #18, ADR-004, ADR-005, ADR-007 (amendment 2026-10-03), PRD FR-010, FR-014; feeds #26, #27, #36

## What happened

The task-worker agent built `POST /api/session`, the first thing the chat page calls after login. It returns a templated greeting ("Hi Maria! I see you're booked with Dr. Priya Lee on Tuesday, October 13, 2026 at 2:30 PM ET. How can I help today?") and the patient's current conversation, so a page reload doesn't lose the chat. There's no model call. The function is its own read-only Lambda with `GetItem` and `Query` on the base table and nothing else, behind the same Cognito authorizer as `/api/chat`.

The method was settled before any code: CloudFront drops `Authorization` on GET, so a `GET /api/session` would always have been a 401 (ADR-007). It's a POST with an empty or `{}` body.

## Why we chose what we chose

- **Restore rebuilds the live bubbles, not the stored messages.** The store keeps everything the model needs to continue: reasoning blocks, tool calls and tool results. None of that is for the patient. But the stored *assistant* messages don't map one to one onto what the patient saw either. A turn that calls a tool stores "Let me check." and the final answer as two assistant messages, and the live stream showed them as one bubble with a blank line between them (`TEXT_BLOCK_SEPARATOR` in the agent loop). So restore takes everything the assistant said between two patient messages, keeps the non-empty text blocks, and joins them the same way. The bubble's ID is its last assistant message's, which for a completed turn is the `messageId` the `done` event carried. A test pins the separator to the loop's constant, so the two can't drift apart. Without this rule a reload would split one answer into two bubbles, with the "Let me check." preamble on its own.
- **The current conversation is the patient's newest.** The spec doesn't define "current". The only patient-scoped way to find a conversation is the meta item list (`PATIENT#<sub> / CONV#<createdIso>#<id>`), newest first, so the session reads one item of it and then `listMessages(patientId, id)`. There's no recency cutoff: a patient who comes back after a week sees last week's chat, and the next message continues it. Messages expire after 30 days (ADR-004), and a conversation whose messages are gone is returned as `conversationId: null`, so the next turn starts a new one. FR-014 only asks for restore "within the session", and only the SPA knows when a login session began, so Nick decided on the PR to keep the endpoint as it is and put the rule on #27: the SPA keeps the `conversationId` per login session and discards a restore from another session ([note on #27](https://github.com/nick-delgado/serverless-ai-scheduling/issues/27#issuecomment-5974200603)).
- **A patient with no profile still gets a session.** The chat works for them (the system prompt takes a null first name), so a 404 would block the page for a seeding gap. The greeting says "Hi there!" and `patient.firstName` is `"Patient"`, because the contract requires a non-empty name. Making `patient` nullable would be cleaner, but that's a contract change across streams. Nick kept the placeholder for now; #121 tracks the nullable name, to be taken up if the chat page (#26/#27) shows it. The ID token carries no name claim, so there's nothing better to fall back on.
- **Only BOOKED appointments are mentioned.** `get_my_appointments` returns cancelled upcoming appointments on purpose ("did my cancellation go through?"), but a greeting that says "you're booked" for a cancelled visit would be wrong. The time rule is the tool's: an appointment that starts exactly now still counts.
- **The session bundle carries no agent.** `config.ts` imports `@sched/agent` for the model profile, which pulls in the Bedrock runtime client. The env readers moved to `lib/env.ts` (re-exported from `config.ts`, so the chat handler is unchanged), and the display mapping copies the separator instead of importing it. The session bundle is 1.68 MB against the chat's 1.87 MB, with no Bedrock code in it, and `services/api/test/session-bundle.test.ts` bundles it with esbuild and fails if anything under `packages/agent/` or the Bedrock runtime client gets in.

## What surprised us

- **The deployer role can't invoke a Lambda.** The plan was to measure the warm p95 with `aws lambda invoke` and a synthetic authorizer event. The `SchedDeployer` SSO role has no `lambda:InvokeFunction`, so that measurement is still to do. Nick decided on the PR that it's measured before merge, through CloudFront as a seeded demo user, with the handler's `totalMs` and Lambda's `Duration` from CloudWatch Logs; the numbers go in the PR.
- **A new API Gateway route isn't live everywhere at once.** For a few minutes after the deploy, unauthenticated `POST /api/session` flapped between 401 (the authorizer, correct) and 403 `Missing Authentication Token` (a host still serving the old deployment), even though the stage already pointed at the new deployment.

## Evidence

- Tests in `services/api`: display mapping, the session core over in-memory repositories with a frozen clock, the Lambda wiring, the template (IAM, environment variables, route, authorizer, invoke permission, Makefile target), the bundle's inputs, and a DynamoDB Local suite over the real repositories. Each break listed on the PR turned at least one of them red.
- `sam validate --lint` passes; `sched-dev-api` deployed from `feat/18-session-endpoint`.
