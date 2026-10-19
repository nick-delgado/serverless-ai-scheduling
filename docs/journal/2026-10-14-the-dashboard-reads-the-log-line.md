# 2026-10-14 — The dashboard reads the turn's log line, and Powertools' wrappers can't see a streaming handler's context

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #38 (AC1 to AC7, part 2 of 2), PR #263, PR #261 (part 1), NFR-001, NFR-007, FR-051, ADR-002, ADR-003, ADR-009

## What happened

#38 asks for latency, tokens, errors and per-turn traces to be visible without logging any message text. Part 1 (PR #261) shipped the trace viewer. This part adds the rest. A task-worker agent built it to Nick's answers on the readiness review (r1/Q-1 to Q-7, A-1 to A-9):

- **Logs.** A Powertools Logger now sits behind our `Logger` type (Q-4 (a)), and `consoleLogger` is gone. The log calls in `chat-turn.ts` and `session.ts` didn't change. Each line now also carries the Lambda request ID, `cold_start` and the X-Ray trace ID.
- **Metrics.** A decorator on that logger reads the turn's metrics from the one `"chat turn"` entry (Q-2 (a), Q-3 (a)), under namespace `Sched`: `Turns`, `TurnErrors`, `TimeToFirstTextMs`, `TurnLatencyMs`, the four token sums, `ToolCalls` and `ToolErrors`. The `Env` figures go into a store that the handler wrapper flushes as one embedded-metric (EMF) record per invocation. Each error code (the turn's own, and each tool error code) gets an `Env`+`ErrorCode` record of its own. Nick confirmed this reading on the PR (`9a7d759/SPEC-1` (a)): "one record per turn" in Q-2 and Q-3 means the figures come from the one log entry. `chat-turn.ts` didn't change.
- **Conflict retries.** `createDynamoRepositories` takes an optional `onConflictRetry` hook. `book` and `reschedule` call it at their conflict-only branches, and the chat function counts each call as `BookingConflictRetries` (Q-6 (a)).
- **Failed status writes.** When the escalation's status write throws or finds no record, `withNotificationFailedMetric` logs one error entry, `"notification status write failed"`, with IDs only (A-2).
- **Tracing.** X-Ray runs on the chat function only. It captures the Bedrock, DynamoDB and SES clients (Q-5 (a)).
- **The dashboard.** `sched-<env>-api` charts all of it, with #35's alarm state in a widget beside `NotificationFailed`. The alarm still has no action (Q-1 (a), ADR-003's 2026-10-14 amendment).

## What we checked before building (A-4, A-5)

- **A-4: Powertools Metrics writes raw stdout.** The Lambda runtime wraps the global `console` under `LogFormat: JSON`, and CloudWatch doesn't read a wrapped line as EMF. Powertools Metrics and Logger each build their own `new Console({ stdout: process.stdout, stderr: process.stderr })`, unless `POWERTOOLS_DEV` is set (`@aws-lambda-powertools/metrics` 2.36, `Metrics.setConsole`). So a record is one raw line. A test pins it: the record arrives through `process.stdout.write`, and `console.log` is never called. On `dev` the records became metrics (below), so `emfFailureReporter` could stay where it is.
- **A-5: Powertools' handler wrappers read the wrong argument.** `injectLambdaContext`, `logMetrics` and `captureLambdaHandler` read the context from the handler's second argument (`args[1]`). A `streamifyResponse` handler is called with `(event, responseStream, context)`, so they would have read the response stream as the context. `lib/observability/lambda.ts` does their two jobs by hand. It calls `addContext` with the third argument, and it flushes the stored metrics once per invocation in a `finally`, writing nothing if nothing was stored. The tracer doesn't need a wrapper: capturing the SDK clients is enough, and the `dev` trace below shows the subsegments.

## Why we chose what we chose

The spec left these open, and the agent settled them:

- **One turn's metrics are one `Env` record, plus one record per error code** (confirmed by Nick on the PR, `9a7d759/SPEC-1` (a)). An EMF record holds one value per dimension. So a turn that ended `RATE_LIMITED` and had a tool fail `NOT_FOUND` can't put both under `ErrorCode` in one record. The turn's `Env` figures are one record. Each `Env`+`ErrorCode` figure is a record of its own: one for the turn's code, and one per tool error code. The alternative was a second dimension name for tool errors, such as `ToolErrorCode`, which departs from Q-3's catalogue.
- **The `Env` record is flushed once per invocation.** The handler wrapper writes it after the turn (A-5), with any `BookingConflictRetries` the turn counted. The per-code records are written when the turn's log entry is. The alternative was to publish each conflict retry as a record of its own when it happens.
- **Powertools' `service` dimension is removed.** Powertools Metrics adds `service` (`service_undefined` when none is set) to every dimension set. The metrics would then have been `Env`+`service`, and the dashboard's `Env`-only queries would have found nothing. `envMetrics` clears the default dimensions and sets `Env` alone, and a test checks that the record's dimensions are exactly `[["Env"]]`.
- **Counts can be zero; figures are never invented.** A turn that ran the agent writes `TurnErrors`, `ToolCalls` and `ToolErrors` even when they're zero. A turn that has no latency, TTFT or token figure writes none, as Q-3 says, and a replay writes only `Turns`. The alternative was to write `TurnErrors` only for failed turns, which shows a gap instead of 0 when nothing fails.
- **An unreadable `"chat turn"` entry logs a warning.** If a field the metrics read is missing or of the wrong type, the decorator logs `"turn metrics skipped"` with the field names and writes no metric. An error code that isn't a string is recorded as `UNKNOWN`. The alternative was to write nothing, so a renamed field would only show as an empty dashboard.
- **The A-2 entry calls the status `notificationStatus`.** The `"chat turn"` line already uses `status` for the HTTP status. The entry has no request ID of its own (the repositories are built once per container), so its Lambda request ID joins it to its turn.
- **No HTTPS capture.** With `captureHTTPsRequests: false` the trace holds the SDK clients' subsegments only, not a second HTTP subsegment for each call. `POWERTOOLS_TRACER_CAPTURE_RESPONSE` and `_ERROR` are `false` on the chat function. With no method decorators they change nothing today; they keep a decorator someone adds later from recording payloads.
- **The chat handler builds the Bedrock client.** To capture it, `handlers/chat.ts` passes `new BedrockRuntimeClient({})` to `ConverseLlmClient`, relying on the SDK's own default of 3 attempts and `AWS_REGION`. `@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-sesv2` are now direct dependencies of `@sched/api`, at the versions already in the lockfile.

## What surprised us

- **CloudWatch rejected the first dashboard, and the deploy rolled back.** We gave the `NotificationFailed` chart both its metric and the alarm as an annotation. CloudWatch accepts one or the other in a metric widget, not both ("Should match exactly one schema in oneOf", `/widgets/5/properties`). The stack rolled back cleanly. The alarm's state is now an alarm widget beside the chart, and the template test checks that it sits there.
- **Logs Insights compared the JSON booleans inconsistently.** On `dev`, `stats count(*) by replayed` showed `replayed` as 0 and 1. Yet `filter replayed = 0` matched one of the three turns that had it false. The NFR-001 query in ADR-002's amendment filters on `modelProfile` instead, which replays and refused turns don't have.
- **X-Ray times a model call only until its stream opens.** The three `ConverseStream` subsegments of the tool turn below took 1,107, 839 and 863 ms, about 2.8 s in all, in a 5.5 s function run. A subsegment closes when the response's headers arrive, not when the stream ends. The DynamoDB trace (`scripts/trace.ts`) stays the per-turn record of model time.

## Evidence

- The api stack is deployed to `dev` from `433b81a` (`scripts/deploy.sh api dev`). The first attempt, at `69dd9d3`, rolled back on the dashboard.
- The live turns on 2026-10-14, about $0.04 of `sonnet-4.6`: one greeting, one availability question that made two tool calls, one body without a `clientMessageId` (400), and one replay of the greeting. The dashboard's figures over the hour: TTFT p50 1,539 ms and p95 4,634 ms; turn latency p50 2,253 ms and p95 5,519 ms; 4 turns and 1 `TurnErrors` (`BAD_REQUEST`); tokens: 8 input, 564 output, 17,141 cache reads and 7,181 cache writes; 2 tool calls and 0 tool errors; no `NotificationFailed`; no `BookingConflictRetries`. Two samples are too few for real percentiles. The 30-turn NFR-001 measurement stays #37's, and #251 re-measures it.
- The ADR-002 amendment's query over the same window: first text p50 1,509 ms, `done` p95 5,542 ms, 2 turns.
- X-Ray trace `1-6acff558-2715b3472f40723b423419be` (the tool turn) has 3 `BedrockRuntime ConverseStream` subsegments and 8 `DynamoDB` subsegments (`GetItem`, `PutItem`, `Query`, `UpdateItem`, `TransactWriteItems`). Each subsegment carries only `aws` and `http` metadata: operation, table name, request ID, retries. There's no request or response body.
- The new log lines are top-level JSON, with `message`, `service`, `cold_start`, `function_request_id` and `xray_trace_id` beside the entry's own fields. That holds for both functions.
- Seen failing: the `npm run mutate -- … --markdown` tables in the PR body.

## What's next

- #251 reads TTFT from the `TimeToFirstTextMs` widget, or from the ADR-002 amendment's query. **Later (2026-10-19):** #251 read it from the query, with a `promptVersion` filter; see [A line before the first lookup](2026-10-19-a-line-before-the-first-lookup.md).
- `BookingConflictRetries` is the number to read before tuning `MAX_ATTEMPTS` (journal 2026-09-29). Tuning it stays out of #38.
- The failed-notification alarm only changes state. If someone needs to be paged, that's an SNS topic and a bootstrap change, which Nick chose against on Q-1.
