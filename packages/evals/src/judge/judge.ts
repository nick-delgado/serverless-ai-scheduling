/**
 * The LLM judge (#32, ADR-008). One model call per trial scores every rubric dimension the trial is
 * judged on (r1/A-6). Its model is configuration: any profile, `haiku-4.5` by default (r1/Q-4: it differs
 * from the development-default agent and has its own rate-limit bucket), set with `--judge-profile` or
 * `JUDGE_MODEL_PROFILE`. Pass it the `rateLimited()` client the agent and simulator use, so every call
 * shares one per-model quota.
 *
 * A reply that fails `parseJudgeReply` is retried once, with the problems listed (r1/A-8). A second bad
 * reply, or a model call that throws (`rateLimited()` has already retried the transport), is a
 * `JudgeError` carrying what the calls cost; the grading step turns it into `skip` results (r1/A-9).
 *
 * The retry loop is `callWithFeedback` (`feedback-retry.ts`), shared with the simulator, and the request
 * comes from `@sched/agent`'s `profileRequest`, so it carries a system cache point when the profile asks
 * for one (#105).
 */
import {
  addUsage,
  profileRequest,
  type LlmClient,
  type ModelProfile,
  type ModelProfileName,
} from "@sched/agent";

import { callWithFeedback } from "../feedback-retry";
import { zeroSimulatorCost, type RejectedReply, type SimulatorCost } from "../simulator/types";
import type { TranscriptEvent } from "../transcript";
import { parseJudgeReply, type DimensionScore } from "./parse";
import { judgeSystemPrompt, judgeUserMessage, renderJudgeTranscript } from "./prompt";
import { JUDGE_RUBRIC_VERSION, type RubricDimension } from "./rubrics";

/** The environment variable that selects the judge's model profile. */
export const JUDGE_PROFILE_ENV = "JUDGE_MODEL_PROFILE";
/** The judge's default profile (r1/Q-4). */
export const DEFAULT_JUDGE_PROFILE: ModelProfileName = "haiku-4.5";

/** What the judge's calls cost: the same shape as the simulator's. */
export type JudgeCost = SimulatorCost;
export const zeroJudgeCost = zeroSimulatorCost;

/** Add `more`'s tokens, cost and model calls into `total` (the runner's simulator cost, a calibration run). */
export function addCost(total: JudgeCost, more: JudgeCost): void {
  total.usage = addUsage(total.usage, more.usage);
  total.costUsd += more.costUsd;
  total.llmCalls += more.llmCalls;
}

export interface JudgeInput {
  dimensions: readonly RubricDimension[];
  events: readonly TranscriptEvent[];
  /** The agent's system prompt; shown to the judge only when `no_system_prompt_disclosure` is judged. */
  agentSystemPrompt: string;
}

export interface JudgeVerdict {
  scores: DimensionScore[];
  cost: JudgeCost;
  /** Replies rejected on the way to this one; the runner records them as `TrialResult.judgeRejected`. */
  rejected?: RejectedReply[];
}

/** Anything that scores a trial: the LLM judge, or a stand-in in tests. */
export interface TrialJudge {
  /** Recorded in reports, e.g. `llm:haiku-4.5:judge.v1`. */
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

/**
 * The judge couldn't produce a valid verdict. `cost` is what its calls cost anyway, and `rejected` the
 * replies it turned down on the way.
 */
export class JudgeError extends Error {
  override readonly name = "JudgeError";
  readonly cost: JudgeCost;
  readonly rejected: readonly RejectedReply[];

  constructor(message: string, cost: JudgeCost, rejected: readonly RejectedReply[] = []) {
    super(message);
    this.cost = cost;
    this.rejected = rejected;
  }
}

export interface LlmJudgeOptions {
  /** A live client wrapped in `rateLimited()`, or a scripted one in tests. */
  llm: LlmClient;
  profile: ModelProfile;
}

/** Model calls per verdict: the first, and one retry (AC 6). */
export const JUDGE_MAX_ATTEMPTS = 2;

export class LlmJudge implements TrialJudge {
  readonly name: string;
  readonly profile: ModelProfile;
  readonly #llm: LlmClient;

  constructor(options: LlmJudgeOptions) {
    this.#llm = options.llm;
    this.profile = options.profile;
    this.name = `llm:${options.profile.name}:${JUDGE_RUBRIC_VERSION}`;
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const transcript = renderJudgeTranscript(input.events);
    const showPrompt = input.dimensions.includes("no_system_prompt_disclosure");
    const system = judgeSystemPrompt(input.dimensions);
    const profile = this.profile;
    const { value, cost, rejected } = await callWithFeedback({
      llm: this.#llm,
      profile,
      maxAttempts: JUDGE_MAX_ATTEMPTS,
      request: (rejectedSoFar) => ({
        ...profileRequest(profile, { stable: system }),
        tools: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: judgeUserMessage(
                  transcript,
                  showPrompt ? input.agentSystemPrompt : undefined,
                  rejectedSoFar,
                ),
              },
            ],
          },
        ],
      }),
      parse: (text) => {
        const parsed = parseJudgeReply(text, input.dimensions, transcript);
        return parsed.ok ? { ok: true, value: parsed.scores } : parsed;
      },
      error: (message, spent, rejectedSoFar) => new JudgeError(message, spent, rejectedSoFar),
      exhausted: `no valid verdict in ${JUDGE_MAX_ATTEMPTS} attempts`,
    });
    return { scores: value, cost, ...(rejected === undefined ? {} : { rejected }) };
  }
}
