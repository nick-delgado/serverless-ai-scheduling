/**
 * One model call with retry-with-feedback (#105): the loop the patient simulator (#31) and the judge (#32)
 * each kept a copy of. Each attempt calls the model with the request the caller builds from the replies
 * rejected so far (so the retry can say what was wrong), and parses the reply. A reply that isn't an
 * `end_turn`, or that the caller's `parse` rejects, is recorded with its problems and retried, up to
 * `maxAttempts` calls.
 *
 * - **Cost:** every attempt's usage is summed, and `costUsd` is recomputed from the sum after each call
 *   (`estimateCostUsd`), so a value, and an error, both carry what every call cost.
 * - **Success:** the parsed value, the cost and, only when there were any, the rejected replies.
 * - **Failure:** the caller's `error(message, cost, rejected)`, so each caller keeps its own error class
 *   (`SimulatorError`, `JudgeError`) and what it carries. A model call that throws gives
 *   `model call failed: <Name>: <message>` and stops at once (`rateLimited()` has already retried the
 *   transport). Running out of attempts gives `<exhausted>: <problems>`, each rejected reply's problems
 *   joined with ", " and the replies with " | ".
 */
import { addUsage, estimateCostUsd, type LlmClient, type LlmRequest, type ModelProfile } from "@sched/agent";

import { zeroSimulatorCost, type RejectedReply, type SimulatorCost } from "./simulator/types";
import { textOf } from "./transcript";
import { errorReason } from "./util";

/** A reply the caller accepts, as its value, or rejects with the problems to feed back. */
export type FeedbackParse<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export interface FeedbackRetryOptions<T> {
  llm: LlmClient;
  /** Prices the calls. */
  profile: ModelProfile;
  /** Model calls at most, the first included. */
  maxAttempts: number;
  /** The request for the next attempt, given the replies rejected so far (empty on the first). */
  request: (rejected: readonly RejectedReply[]) => LlmRequest;
  /** Read an `end_turn` reply's visible text. */
  parse: (text: string) => FeedbackParse<T>;
  /** The error to throw, carrying the cost of every call so far and the rejected replies. */
  error: (message: string, cost: SimulatorCost, rejected: RejectedReply[]) => Error;
  /** The start of the message when every attempt was rejected, e.g. `no valid verdict in 2 attempts`. */
  exhausted: string;
}

export interface FeedbackResult<T> {
  value: T;
  cost: SimulatorCost;
  /** Present only when a reply was rejected on the way. */
  rejected?: RejectedReply[];
}

export async function callWithFeedback<T>(options: FeedbackRetryOptions<T>): Promise<FeedbackResult<T>> {
  const cost = zeroSimulatorCost();
  const rejected: RejectedReply[] = [];

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    let response;
    try {
      response = await options.llm.streamMessage(options.request(rejected));
    } catch (callError) {
      throw options.error(`model call failed: ${errorReason(callError)}`, cost, rejected);
    }
    cost.llmCalls += 1;
    cost.usage = addUsage(cost.usage, response.usage);
    cost.costUsd = estimateCostUsd(options.profile, cost.usage);

    const text = textOf(response.content);
    const parsed: FeedbackParse<T> =
      response.stopReason === "end_turn"
        ? options.parse(text)
        : { ok: false, problems: [`the model stopped with ${response.stopReason}`] };
    if (parsed.ok) return { value: parsed.value, cost, ...(rejected.length === 0 ? {} : { rejected }) };
    rejected.push({ reply: text, problems: parsed.problems });
  }
  throw options.error(
    `${options.exhausted}: ${rejected.map((r) => r.problems.join(", ")).join(" | ")}`,
    cost,
    rejected,
  );
}
