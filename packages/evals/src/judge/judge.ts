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
 * The request is built here, like the simulator's (`simulator/llm.ts`); #105 plans one shared builder.
 */
import { estimateCostUsd, type LlmClient, type ModelProfile } from "@sched/agent";

import { addUsage, zeroSimulatorCost, type SimulatorCost } from "../simulator/types";
import { textOf, type TranscriptEvent } from "../transcript";
import { errorReason } from "../util";
import { parseJudgeReply, type DimensionScore } from "./parse";
import {
  judgeSystemPrompt,
  judgeUserMessage,
  renderJudgeTranscript,
  type RejectedJudgeReply,
} from "./prompt";
import { JUDGE_RUBRIC_VERSION, type RubricDimension } from "./rubrics";

/** The environment variable that selects the judge's model profile. */
export const JUDGE_PROFILE_ENV = "JUDGE_MODEL_PROFILE";
/** The judge's default profile (r1/Q-4). */
export const DEFAULT_JUDGE_PROFILE = "haiku-4.5";

/** What the judge's calls cost: the same shape as the simulator's. */
export type JudgeCost = SimulatorCost;
export const zeroJudgeCost = zeroSimulatorCost;

export interface JudgeInput {
  dimensions: readonly RubricDimension[];
  events: readonly TranscriptEvent[];
  /** The agent's system prompt; shown to the judge only when `no_system_prompt_disclosure` is judged. */
  agentSystemPrompt: string;
}

export interface JudgeVerdict {
  scores: DimensionScore[];
  cost: JudgeCost;
  /** Replies rejected on the way to this one. */
  rejected?: RejectedJudgeReply[];
}

/** Anything that scores a trial: the LLM judge, or a stand-in in tests. */
export interface TrialJudge {
  /** Recorded in reports, e.g. `llm:haiku-4.5:judge.v1`. */
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

/** The judge couldn't produce a valid verdict. `cost` is what its calls cost anyway. */
export class JudgeError extends Error {
  override readonly name = "JudgeError";
  readonly cost: JudgeCost;

  constructor(message: string, cost: JudgeCost) {
    super(message);
    this.cost = cost;
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
    const cost = zeroJudgeCost();
    const rejected: RejectedJudgeReply[] = [];
    const profile = this.profile;

    for (let attempt = 1; attempt <= JUDGE_MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await this.#llm.streamMessage({
          modelId: profile.modelId,
          family: profile.family,
          system: [{ type: "text", text: system }],
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
                    rejected,
                  ),
                },
              ],
            },
          ],
          maxTokens: profile.maxTokens,
          modelFields: profile.modelFields,
          ...(profile.inlineReasoningTag === undefined
            ? {}
            : { inlineReasoningTag: profile.inlineReasoningTag }),
        });
      } catch (callError) {
        throw new JudgeError(`model call failed: ${errorReason(callError)}`, cost);
      }
      cost.llmCalls += 1;
      cost.usage = addUsage(cost.usage, response.usage);
      cost.costUsd = estimateCostUsd(profile, cost.usage);

      const text = textOf(response.content);
      const parsed =
        response.stopReason === "end_turn"
          ? parseJudgeReply(text, input.dimensions, transcript)
          : { ok: false as const, problems: [`the model stopped with ${response.stopReason}`] };
      if (parsed.ok) return { scores: parsed.scores, cost, ...(rejected.length === 0 ? {} : { rejected }) };
      rejected.push({ reply: text, problems: parsed.problems });
    }
    throw new JudgeError(
      `no valid verdict in ${JUDGE_MAX_ATTEMPTS} attempts: ${rejected.map((r) => r.problems.join(", ")).join(" | ")}`,
      cost,
    );
  }
}
