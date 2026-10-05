# Architecture

This is a one-page overview; each part links to the ADR that decided it. It will be updated as spikes land. Anything still marked *Proposed* in an ADR may change.

Parts marked *planned* aren't live yet: the SES escalation email (#35 built the notifier, its IAM grant and the failed-send alarm; #36 wires it into the chat handler) and voice (ADR-006, spike #10, #28/#29). Until #36 lands, escalations are stored with a `FAILED` notification status.

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
                    │  /*     → S3 (OAC)     │   │ Streaming (ADR-006, planned) │
                    │  /api/* → REST API     │   └──────────────────────────────┘
                    └───────────┬────────────┘            ▲
                                │                         │ creds via Cognito
                                ▼                         │ Identity Pool (ADR-005)
                    ┌────────────────────────────────────────────┐
                    │ API Gateway REST API (Regional)            │
                    │  Cognito User Pool authorizer (ADR-005)    │
                    │  POST /api/chat   (response streaming)     │
                    │  POST /api/session (greeting + history)    ├───────────────────┐
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
                    │       escalate_to_human ──► SES (planned)  │                   │
                    └───────────┬────────────────────────────────┘                   │
                                ▼                                                    │
                    ┌────────────────────────────────────────────┐                   │
                    │ DynamoDB single table (ADR-004)            │◄──────────────────┘
                    │  patients · providers · slots (sparse GSI) │
                    │  appointments · conversations · escalations│
                    └────────────────────────────────────────────┘
```

## A chat turn, end to end

1. The SPA sends `POST /api/chat {conversationId?, clientMessageId, text}` with the Cognito ID token.
2. The REST API authorizer validates the JWT. The Lambda receives `claims.sub` as the patient ID.
3. ChatFn loads the conversation history through the owned read (DynamoDB; an unknown or foreign `conversationId` starts a new conversation, ADR-007 amendment). It then matches the send's `clientMessageId` against the last patient message stored there ([ADR-007 2026-10-04 amendment](adr/0007-chat-transport.md#amendment-2026-10-04-chat-retries-as-built-104)). A repeat of an answered message replays the stored reply without a model call; a repeat of an interrupted message re-runs the agent on the history before that message, without storing it again. Neither counts a turn. Only a new message counts against the patient's daily cap (50, ADR-009; 429 when reached), and only a new message is appended before the agent loop runs, so tools that read the stored conversation (the `escalate_to_human` staff transcript) see the turn in progress. ChatFn then calls `runAgentTurn` with the history **as loaded before that append** (the loop adds the user message itself, as the first entry of `newMessages`), plus:
   - a tool executor bound to a `ToolContext` carrying the patientId **from the JWT**, the conversation ID, the clock, the repositories, and the staff notifier when one is configured (none until #36 wires the SES notifier from #35, so escalations are recorded `FAILED`) (the loop itself never sees the patient ID; ADR-001 amendment);
   - `ConverseLlmClient`;
   - the configured `ModelProfile`.
4. The loop calls the configured model (`AGENT_MODEL_PROFILE`, default Sonnet 4.6) through Converse (ADR-010). When the model requests tools, it runs them (in parallel when there are several), emits a `status` event for each, and returns their results to the model. This repeats until the model ends the turn, capped at 8 iterations.
5. Text deltas stream to the browser as NDJSON `text_delta` events (ADR-007). The SPA's typewriter renders them character by character.
6. ChatFn appends the turn's remaining messages, skipping the first entry of `newMessages` (the user message it already stored), so the assistant's replies and tool results plus the turn trace go to DynamoDB, then sends `done`.

## Greeting and restore

On page load the SPA sends `POST /api/session` (empty body, ID token). SessionFn reads the patient's profile, next appointment and newest conversation (DynamoDB GetItem/Query only, no Bedrock) and returns the templated greeting plus that conversation's messages, one bubble per turn, as JSON with `Cache-Control: no-store` (ADR-007 amendment, ADR-004 AP-10).

## Voice input

*(Planned: ADR-006 is Proposed until spike S-3, #10.)*

1. Mic tap → permission prompt (first time) → recording overlay with a timer.
2. The AudioWorklet converts the mic audio to 16 kHz PCM and streams ~100 ms chunks to Transcribe over WebSocket, using Identity Pool credentials that can do nothing else.
3. On Send: the stream is closed, a "Transcribing…" spinner shows while final results arrive, and the transcript is posted as the patient's message. From there it follows the chat-turn path above.

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
| `sched-<env>-api` | data, auth | `/sched/<env>/api/rest-api-id`, `api/execute-api-domain`, `api/stage-name`, `api/status` |
| `sched-<env>-web` | api | `/sched/<env>/web/bucket-name`, `web/distribution-id`, `web/domain`, `web/status` |
