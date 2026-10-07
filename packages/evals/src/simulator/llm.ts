/**
 * The LLM patient simulator (#31, ADR-008). A model profile plays the scenario's persona toward its goal,
 * seeing only the visible conversation. Its model is configuration: any profile from
 * `packages/agent/src/profiles.ts`, `sonnet-4.6` by default (`SIMULATOR_MODEL_PROFILE` or
 * `--simulator-profile`). Pass it a `rateLimited()` client, so its calls and the agent's share one
 * per-model quota.
 *
 * Stop conditions:
 * - goal achieved / gave up / escalated: the model replies with a stop marker alone (`prompt.ts`);
 * - escalation, deterministically: after a successful `escalate_to_human`, the patient gets
 *   `turnsAfterEscalation` more messages (a scenario may need it to ask again), then the simulator stops
 *   without calling the model;
 * - `max_turns`: the runner's.
 *
 * Every reply goes through `replyProblems` (no verbatim goal or hidden facts, never the assistant's
 * voice). A rejected reply is never sent: the model is asked again with the problems listed, up to
 * `maxAttempts` calls, then the turn fails with a `SimulatorError` (the trial is `error`, not `fail`).
 * A model call that throws fails the turn the same way, carrying what the earlier attempts cost. The
 * retry loop is `callWithFeedback` (`feedback-retry.ts`), shared with the judge, and the request comes
 * from `@sched/agent`'s `profileRequest`, so it carries a system cache point when the profile asks for
 * one (#105).
 */
import { profileRequest, type LlmClient, type ModelProfile, type ModelProfileName } from "@sched/agent";

import { callWithFeedback } from "../feedback-retry";
import type { TranscriptEvent } from "../transcript";
import { replyProblems } from "./guards";
import {
  SIMULATOR_PROMPT_VERSION,
  SIMULATOR_STOP_REASONS,
  STOP_MARKER_PATTERN,
  simulatorSystemPrompt,
  simulatorUserMessage,
  type SimulatorStopReason,
} from "./prompt";
import { SimulatorError, type PatientSimulator, type SimulatorContext, type SimulatorTurn } from "./types";

/** The environment variable that selects the simulator's model profile (default `DEFAULT_SIMULATOR_PROFILE`). */
export const SIMULATOR_PROFILE_ENV = "SIMULATOR_MODEL_PROFILE";

/**
 * The simulator's profile when neither `--simulator-profile` nor `SIMULATOR_MODEL_PROFILE` names one
 * (ADR-008's 2026-10-02 amendment). Its own value, not the agent's `DEFAULT_MODEL_PROFILE`, so the M3
 * matrix (#37) moving the agent's default doesn't move the simulator (#108).
 */
export const DEFAULT_SIMULATOR_PROFILE: ModelProfileName = "sonnet-4.6";

export interface LlmPatientSimulatorOptions {
  /** A live client wrapped in `rateLimited()`, or a scripted one in tests. */
  llm: LlmClient;
  profile: ModelProfile;
  /** Model calls per turn, retries of rejected replies included. Default 3. */
  maxAttempts?: number;
  /** Patient messages allowed after a successful escalation before the simulator stops. Default 2. */
  turnsAfterEscalation?: number;
}

/** The outcome of reading one model reply. */
export type ParsedReply =
  | { kind: "message"; message: string }
  | { kind: "stop"; reason: SimulatorStopReason }
  | { kind: "invalid"; problems: string[] };

const SPEAKER_LABEL = /^\s*(patient|me|user|you)\s*:\s*/i;

/** Strip what models wrap a chat line in: a leading `Patient:` label, and quotes around the whole reply. */
export function cleanReply(text: string): string {
  let t = text.trim().replace(SPEAKER_LABEL, "").trim();
  const wrapped = /^(["“])([\s\S]*)(["”])$/.exec(t);
  if (wrapped?.[2] !== undefined && !/["“”]/.test(wrapped[2])) t = wrapped[2].trim();
  return t;
}

const isStopReason = (value: string): value is SimulatorStopReason =>
  (SIMULATOR_STOP_REASONS as readonly string[]).includes(value);

/** Read one model reply: a stop marker alone, a patient message that passes the guards, or neither. */
export function parseReply(text: string, scenario: SimulatorContext["scenario"]): ParsedReply {
  const reply = cleanReply(text);
  const marker = STOP_MARKER_PATTERN.exec(reply);
  if (marker !== null) {
    const reason = (marker[1] ?? "")
      .trim()
      .toLowerCase()
      .replaceAll(/[\s-]+/g, "_");
    const rest = reply.replace(marker[0], "").trim();
    const problems = [
      ...(isStopReason(reason) ? [] : [`"${marker[1] ?? ""}" is not a stop reason`]),
      ...(rest.length > 0 ? ["it mixes a stop marker with a message; send one or the other"] : []),
    ];
    return problems.length === 0 && isStopReason(reason)
      ? { kind: "stop", reason }
      : { kind: "invalid", problems };
  }
  if (reply.length === 0) return { kind: "invalid", problems: ["it is empty"] };
  const problems = replyProblems(reply, scenario);
  return problems.length === 0 ? { kind: "message", message: reply } : { kind: "invalid", problems };
}

/** Patient messages sent after the first successful `escalate_to_human`, or `undefined` if none happened. */
export function messagesSinceEscalation(events: readonly TranscriptEvent[]): number | undefined {
  const at = events.findIndex((e) => e.kind === "tool_call" && e.name === "escalate_to_human" && e.ok);
  if (at < 0) return undefined;
  return events.slice(at + 1).filter((e) => e.kind === "patient").length;
}

export class LlmPatientSimulator implements PatientSimulator {
  readonly name: string;
  readonly #llm: LlmClient;
  readonly #profile: ModelProfile;
  readonly #maxAttempts: number;
  readonly #turnsAfterEscalation: number;

  constructor(options: LlmPatientSimulatorOptions) {
    this.#llm = options.llm;
    this.#profile = options.profile;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#turnsAfterEscalation = Math.max(0, options.turnsAfterEscalation ?? 2);
    this.name = `llm:${options.profile.name}:${SIMULATOR_PROMPT_VERSION}`;
  }

  async next(context: SimulatorContext): Promise<SimulatorTurn> {
    const sinceEscalation = messagesSinceEscalation(context.events);
    if (sinceEscalation !== undefined && sinceEscalation >= this.#turnsAfterEscalation)
      return { stop: "escalated" };

    const { scenario } = context;
    const system = simulatorSystemPrompt(scenario);
    const profile = this.#profile;
    const { value, cost, rejected } = await callWithFeedback<Exclude<ParsedReply, { kind: "invalid" }>>({
      llm: this.#llm,
      profile,
      maxAttempts: this.#maxAttempts,
      request: (rejectedSoFar) => ({
        ...profileRequest(profile, { stable: system }),
        tools: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: simulatorUserMessage(context.events, context.turn, scenario.max_turns, rejectedSoFar),
              },
            ],
          },
        ],
      }),
      parse: (text) => {
        const parsed = parseReply(text, scenario);
        return parsed.kind === "invalid"
          ? { ok: false, problems: parsed.problems }
          : { ok: true, value: parsed };
      },
      // Keep what the earlier, rejected attempts cost: the runner adds it to the trial and the budget.
      error: (message, spent) => new SimulatorError(message, spent),
      exhausted: `no usable patient reply in ${this.#maxAttempts} attempt(s)`,
    });
    const seen = rejected === undefined ? {} : { rejected };
    return value.kind === "message"
      ? { message: value.message, cost, ...seen }
      : { stop: value.reason, cost, ...seen };
  }
}
