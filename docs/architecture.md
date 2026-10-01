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
                    ┌────────────────────────┐   ┌──────────────────────────┐
                    │ CloudFront             │   │ Amazon Transcribe        │
                    │  /*     → S3 (OAC)     │   │ Streaming (ADR-006)      │
                    │  /api/* → REST API     │   └──────────────────────────┘
                    └───────────┬────────────┘            ▲
                                │                         │ creds via Cognito
                                ▼                         │ Identity Pool (ADR-005)
                    ┌────────────────────────────────────────────┐
                    │ API Gateway REST API (Regional)            │
                    │  Cognito User Pool authorizer (ADR-005)    │
                    │  POST /api/chat   (response streaming)     │
                    │  GET  /api/session (greeting + history)    │
                    └───────────┬────────────────────────────────┘
                                ▼
                    ┌────────────────────────────────────────────┐
                    │ ChatFn (Lambda, Node 24, streamifyResponse)│
                    │  runAgentTurn()  — packages/agent (ADR-001)│
                    │   ├─ LlmClient → Claude on Bedrock (ADR-002)│
                    │   └─ ToolRegistry — packages/tools         │
                    │       find_providers · check_availability  │
                    │       get_my_appointments · get_patient_profile
                    │       book_appointment · reschedule_appointment
                    │       escalate_to_human ──► Amazon SES     │
                    └───────────┬────────────────────────────────┘
                                ▼
                    ┌────────────────────────────────────────────┐
                    │ DynamoDB single table (ADR-004)            │
                    │  patients · providers · slots (sparse GSI) │
                    │  appointments · conversations · escalations│
                    └────────────────────────────────────────────┘
```

## A chat turn, end to end

1. The SPA sends `POST /api/chat {conversationId, text}` with the Cognito ID token.
2. The REST API authorizer validates the JWT. The Lambda receives `claims.sub` as the patient ID.
3. ChatFn loads the conversation history (DynamoDB) and appends the patient's new message before the agent loop runs, so tools that read the stored conversation (the `escalate_to_human` staff transcript) see the turn in progress. It then calls `runAgentTurn` with:
   - a `ToolContext` carrying the patientId **from the JWT**, the clinic timezone, and the clock;
   - the Bedrock `LlmClient`;
   - the configured `ModelProfile`.
4. The loop calls Claude. When Claude requests tools, it runs them (in parallel when there are several), emits a `status` event for each, and returns their results to Claude. This repeats until Claude ends the turn, capped at 8 iterations.
5. Text deltas stream to the browser as NDJSON `text_delta` events (ADR-007). The SPA's typewriter renders them character by character.
6. ChatFn appends the turn's remaining messages (the assistant's replies and tool results) and the turn trace to DynamoDB, then sends `done`.

## Voice input

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

| Stack | Depends on | Publishes (SSM `/sched/<env>/…`) |
|---|---|---|
| `sched-bootstrap` | — | CFN exec role ARN, artifact bucket |
| `sched-<env>-data` | bootstrap | table name/ARN |
| `sched-<env>-auth` | bootstrap | user pool ID, client ID, identity pool ID |
| `sched-<env>-api` | data, auth | REST API ID/URL |
| `sched-<env>-web` | api | CloudFront domain, site bucket |
