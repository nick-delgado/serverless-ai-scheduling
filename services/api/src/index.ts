/**
 * @sched/api: Lambda handlers for `POST /api/chat` (streaming, #17) and `GET /api/session` (#18).
 *
 * This entry point exports the transport-free chat turn core and its in-memory helpers, so the eval
 * harness can run the real handler in-process with injected repositories, clock, LLM and notifier (#30).
 * It never loads the AWS SDK: the Lambda wiring lives in `handlers/` and `lib/aws.ts`.
 */
export const PACKAGE_NAME = "@sched/api";

export {
  DEFAULT_DAILY_TURN_CAP,
  handleChatTurn,
  type ChatTurnDeps,
  type ChatTurnInput,
  type ChatTurnSummary,
} from "./lib/chat-turn";
export { FAILURES, classifyAgentError, type ChatFailure } from "./lib/errors";
export { INTERRUPTED_REPLY } from "./lib/history";
export { consoleLogger, errorSummary, silentLogger, type LogEntry, type Logger } from "./lib/log";
export { bodyText, parseJsonBody, patientIdFromEvent, type RestApiProxyEvent } from "./lib/request";
export { EventWriter, NDJSON_HEADERS, memorySink, type CapturedResponse, type EventSink } from "./lib/stream";
export {
  PLACEHOLDER_PROMPT_VERSION,
  placeholderSystemPrompt,
  type SystemPromptContext,
  type SystemPromptFactory,
} from "./lib/system-prompt";
export {
  createInMemoryTurnStore,
  type ConsumeTurnResult,
  type InMemoryTurnStore,
  type TurnStore,
} from "./lib/turn-store";
