# Architecture

This is a one-page overview; each part links to the ADR that decided it. It will be updated as spikes land. Anything still marked *Proposed* in an ADR may change.

## System diagram

```
                         ┌──────────────────────────────────────────────┐
  Patient browser        │ React SPA (apps/web)                         │
  (desktop / mobile)     │  Login · Chat · Mic overlay · Typewriter     │
                         └───────┬───────────────────────┬──────────────┘
                                 │ HTTPS                 │ WebSocket (SigV4, temp creds)
                                 ▼                       ▼
                    ┌────────────────────────┐   ┌──────────────────────────────┐
                    │ CloudFront             │   │ Amazon Transcribe            │
                    │  /*     → S3 (OAC)     │   │ Streaming (ADR-006)          │
                    │  /api/* → REST API     │   └──────────────────────────────┘
                    └───────────┬────────────┘            ▲
                                │                         │ creds via Cognito
                                ▼                         │ Identity Pool (ADR-005)
                    ┌────────────────────────────────────────────┐
                    │ API Gateway REST API (Regional)            │
                    │  Cognito User Pool authorizer (ADR-005)    │
                    │  POST /api/chat   (response streaming)     │
                    │  POST /api/session (greeting + history)    ├───────────────────┐
                    │  POST /api/request-access (public, if on)  │                   │
                    └───────────┬────────────────────────────────┘                   │
                                ▼ POST /api/chat                                     ▼
                    ┌────────────────────────────────────────────┐    ┌──────────────────────────────┐
                    │ ChatFn (Lambda, Node 24, streamifyResponse)│    │ SessionFn (Lambda, Node 24)  │
                    │  runAgentTurn()  — packages/agent (ADR-001)│    │  JSON greeting + restore     │
                    │   ├─ LlmClient → Bedrock Converse (ADR-010)│    │  DynamoDB GetItem · Query    │
                    │   └─ ToolRegistry — packages/tools         │    │  no Bedrock                  │
                    │       find_providers · check_availability  │    └──────────────┬───────────────┘
                    │       get_my_appointments · get_patient_profile                │
                    │       book_appointment · reschedule_appointment                │
                    │       escalate_to_human ──► SES            │                   │
                    └───────────┬────────────────────────────────┘                   │
                                ▼                                                    │
                    ┌────────────────────────────────────────────┐                   │
                    │ DynamoDB single table (ADR-004)            │◄──────────────────┘
                    │  patients · providers · slots (sparse GSI) │
                    │  appointments · conversations · escalations│
                    └────────────────────────────────────────────┘
```

## A chat turn, end to end

<!-- sync-start:chat-turn-order (restated in the header of services/api/src/lib/chat-turn.ts) -->

1. The SPA sends `POST /api/chat {conversationId?, clientMessageId, text, inputMode?}` with the Cognito ID token (`inputMode` is `"voice"` for a transcript from the voice overlay and `"text"` or absent otherwise; the client supplies it, so it is untrusted and can only make the agent more careful).
2. The REST API authorizer validates the JWT. The Lambda receives `claims.sub` as the patient ID.
3. ChatFn loads the conversation history through the owned read (DynamoDB; an unknown or foreign `conversationId` starts a new conversation, ADR-007 amendment). It then matches the send's `clientMessageId` against the last patient message stored there ([ADR-007 2026-10-04 amendment](adr/0007-chat-transport.md#amendment-2026-10-04-chat-retries-as-built-104)). A repeat of an answered message replays the stored reply without a model call; a repeat of an interrupted message re-runs the agent on the history before that message, without storing it again. Neither counts a turn. Only a new message counts against the daily caps, the patient's (50) and the whole env's (200 on `demo`), counted together in one transaction before any model call ([ADR-009 2026-10-20 amendment](adr/0009-safety-and-privacy.md#amendment-2026-10-20-an-env-wide-daily-turn-cap-356); 429, no Retry, when either is reached, with the patient's own message shown if both are), and only a new message is appended before the agent loop runs (stored with its `clientMessageId`, and with `inputMode: "voice"` when it was spoken: the stored text stays the patient's words, and the loop and every later turn render a spoken message with the same spoken-message marker before its text, so the earlier history stays byte-stable for prompt caching), so tools that read the stored conversation (the `escalate_to_human` staff transcript) see the turn in progress. A turn that starts a conversation then sends a `conversation` event naming it, the first line of the 200 response, so a Retry after a cut stream continues it ([ADR-007 #160 amendment](adr/0007-chat-transport.md#amendment-2026-10-05-name-a-new-conversation-before-the-agent-runs-160)). ChatFn then calls `runAgentTurn` with the history **as loaded before that append** (the loop adds the user message itself, as the first entry of `newMessages`), plus:
   - a tool executor bound to a `ToolContext` carrying the patientId **from the JWT**, the conversation ID, the clock, the repositories, and the SES staff notifier (#35) when the env has SES addresses (without one, escalations are recorded `FAILED` and the failed-notification metric counts them) (the loop itself never sees the patient ID; ADR-001 amendment);
   - `ConverseLlmClient`;
   - the configured `ModelProfile`.
4. The loop calls the configured model (`AGENT_MODEL_PROFILE`, default Sonnet 4.6) through Converse (ADR-010). When the model requests tools, it runs them (in parallel when there are several), emits a `status` event for each, and returns their results to the model. This repeats until the model ends the turn, capped at 8 iterations.
5. Text deltas stream to the browser as NDJSON `text_delta` events (ADR-007). The SPA's typewriter renders them character by character.
6. ChatFn appends the turn's remaining messages, skipping the first entry of `newMessages` (the user message it already stored), so the assistant's replies and tool results plus the turn trace go to DynamoDB, then sends `done`.

<!-- sync-end:chat-turn-order -->

## Requesting demo access (where the page is on)

Only envs whose `api` stack is deployed with `RequestAccess=on` have this route: an ephemeral check env, and `demo` once Nick turns it on (never `dev` or `e2e`; ADR-005, ADR-009 and ADR-004's amendments of 2026-10-20 and 2026-10-21). It is the API's one route with no authorizer.

1. The sign-in page links to `/request-access`; the page shows a Cloudflare Turnstile widget and one button, and asks for nothing about the reviewer.
2. The SPA sends `POST /api/request-access {turnstileToken}` with no `Authorization`. RequestAccessFn (Lambda, no Bedrock, no agent code) posts the token and its secret to Cloudflare's `siteverify` and goes on only if `success` is true. A failed check creates nothing and counts against no cap; an unreachable Cloudflare answers "try again".
3. It reserves a place: one `TransactWriteItems` adds one to the day's counter and the active counter, each conditional on its cap, and puts a registry entry under `ACCESS#ISSUED`. Past either cap it answers 429 with the "requests have run out" message and creates nothing else.
4. It creates the Cognito user (`AdminCreateUser`, no message, then `AdminSetUserPassword`, permanent), reads its `sub`, and writes the `PATIENT#<sub>` profile and the entry's `sub` in a second transaction. If a step fails, it deletes the user once and answers "try again".
5. It answers with the username, a generated password and the synthetic patient's name, `no-store`; the page shows them once and keeps them in memory only. The reviewer then signs in at `/login` like any patient, and everything after that is the chat turn above, with the identity from the verified token.
6. When the account is due (`RequestAccessExpiryHours` after issue), the hourly ExpireFn (a Lambda started by an EventBridge `rate(1 hour)` rule, no Bedrock) finds the entry with a `Query` on `ACCESS#ISSUED`, checks that the Cognito user's `sub` is the entry's, signs the user out everywhere and deletes it, deletes the patient's items (profile, appointments, conversations with their messages, escalation and traces, turn counters), puts any slot the patient held back to open, and removes the entry and its active place in one transaction. An entry that fails part-way stays and is finished by the next run. An operator can run it as of another time (`{ "asOf": ... }`), which the runbook's revoke-all step does.

## Greeting and restore

On page load the SPA sends `POST /api/session` (empty body, ID token). SessionFn reads the patient's profile, next appointment and newest conversation (DynamoDB GetItem/Query only, no Bedrock) and returns the templated greeting plus that conversation's messages, one bubble per turn, as JSON with `Cache-Control: no-store` (ADR-007 amendment, ADR-004 AP-10).

## Voice input

ADR-006, accepted after spike S-3 (#10). #28 built the mic and the recording overlay; #29 built the real Transcriber (`apps/web/src/voice/transcribe/`), which every build with the Identity Pool ID uses.

1. Mic tap → permission prompt (first time) → recording overlay with a timer.
2. The AudioWorklet converts the mic audio to 16 kHz PCM and streams ~100 ms chunks to Transcribe over WebSocket, using Identity Pool credentials that can do nothing else. The Transcribe SDK loads on first use, and the page becoming hidden while recording is an error the overlay shows (iOS stops the audio).
3. On Send: the audio ends with an empty AudioEvent, a "Transcribing…" spinner shows until Transcribe ends the stream with the final results, and the transcript is posted as the patient's message. From there it follows the chat-turn path above.

## Where the code lives

| Concern | Path | Stream |
|---|---|---|
| Shared schemas (domain, tools, stream events) | `packages/contracts` | M1 |
| Agent loop, LlmClient, prompts, model profiles | `packages/agent` | S3 |
| Tools + repositories (DynamoDB + in-memory) | `packages/tools` | S2, S4 |
| Eval harness | `packages/evals` | S7 |
| Lambda handlers | `services/api` | S3, S8 |
| SPA | `apps/web` | S1, S5, S6 |
| Infrastructure | `infra/` | per ADR-003 table |

## Deployment topology

| Stack | Depends on | Publishes (SSM) |
|---|---|---|
| `sched-bootstrap` | — | `/sched/bootstrap/`: `cfn-exec-role-arn`, `permissions-boundary-arn`, `artifact-bucket` |
| `sched-<env>-data` | bootstrap | `/sched/<env>/data/table-name`, `data/table-arn` |
| `sched-<env>-auth` | bootstrap | `/sched/<env>/auth/user-pool-id`, `auth/user-pool-arn`, `auth/spa-client-id`, `auth/identity-pool-id` |
| `sched-<env>-api` | data, auth | `/sched/<env>/api/rest-api-id`, `api/execute-api-domain`, `api/stage-name`, `api/status`, `api/request-access` |
| `sched-<env>-web` | api | `/sched/<env>/web/bucket-name`, `web/distribution-id`, `web/domain`, `web/status` |
