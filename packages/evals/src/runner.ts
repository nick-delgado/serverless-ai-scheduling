/**
 * Multi-turn scenario runner (L2/L3, ADR-008). Each trial gets a fresh `TrialEnvironment` and drives the
 * real `runAgentTurn` turn by turn: scripted patient messages first, then the `PatientSimulator` (#31),
 * until the simulator stops or `max_turns` is reached. The transcript and the before/after repository
 * snapshots then go to the deterministic graders.
 */
import {
  estimateCostUsd,
  runAgentTurn,
  type LlmClient,
  type LlmMessage,
  type ModelProfile,
} from "@sched/agent";
import type { TokenUsage, TurnOutcome } from "@sched/contracts";
import type { ToolRegistry } from "@sched/tools";

import { errorReason } from "./util";
import { createTrialEnvironment } from "./environment";
import { gradeScenario, safetyViolations, trialPassed, type GraderResult } from "./graders";
import type { Scenario } from "./schema";
import {
  addUsage,
  scriptOnlySimulator,
  SimulatorError,
  zeroSimulatorCost,
  zeroUsage,
  type PatientSimulator,
  type RecordedSimulatorTurn,
  type SimulatorCost,
  type SimulatorTurn,
} from "./simulator";
import { firstNameOf, promptFor, type SystemPromptFactory } from "./system-prompt";
import { assistantTexts, turnEvents, type TranscriptEvent } from "./transcript";

/** The agent configuration under test. */
export interface AgentUnderTest {
  llm: LlmClient;
  profile: ModelProfile;
  /** Builds the system prompt for a trial. Default: the interim prompt until #16 lands. */
  systemPrompt?: SystemPromptFactory;
  /** Tool handlers. Default: the production `TOOL_REGISTRY`. */
  registry?: ToolRegistry;
}

export type TrialStatus = "pass" | "fail" | "skip" | "error";

export interface TrialResult {
  kind: "scenario";
  trial: number;
  status: TrialStatus;
  /** Why a trial was skipped or errored. */
  reason?: string;
  graders: GraderResult[];
  safetyViolations: number;
  events: TranscriptEvent[];
  turns: number;
  outcomes: TurnOutcome[];
  /** Why the conversation ended (simulator stop reason, `max_turns`, or an error). */
  stoppedBecause?: string;
  simulator: string;
  /** What the simulator said each turn after the script (and its stop), for replay (#31). */
  simulatorTurns: RecordedSimulatorTurn[];
  /** The agent's token usage. */
  usage: TokenUsage;
  /** The agent's model calls. */
  llmCalls: number;
  /** Model calls that retried a step after a discarded response (`LlmCallTrace.attempt > 0`). */
  llmRetries: number;
  /** Estimated cost of the whole conversation: the agent's calls plus the simulator's. */
  costUsd: number;
  /** The simulator's share of the conversation: tokens, model calls and cost (#31). */
  simulatorCost: SimulatorCost;
  durationMs: number;
  /** Per-turn wall-clock durations, ms. */
  turnDurationsMs: number[];
}

export interface RunScenarioOptions {
  agent: AgentUnderTest;
  simulator?: PatientSimulator;
  trial?: number;
}

const rejectedOf = (turn: SimulatorTurn) => (turn.rejected === undefined ? {} : { rejected: turn.rejected });

function skipped(trial: number, reason: string, simulator: string): TrialResult {
  return {
    kind: "scenario",
    trial,
    status: "skip",
    reason,
    graders: [],
    safetyViolations: 0,
    events: [],
    turns: 0,
    outcomes: [],
    simulator,
    simulatorTurns: [],
    usage: zeroUsage(),
    llmCalls: 0,
    llmRetries: 0,
    costUsd: 0,
    simulatorCost: zeroSimulatorCost(),
    durationMs: 0,
    turnDurationsMs: [],
  };
}

/** Why this scenario can't run in this harness configuration, if it can't. */
export function skipReason(scenario: Scenario, simulator: PatientSimulator): string | undefined {
  if (scenario.surface === "api") return "needs the chat handler (surface: api, #17)";
  if ((scenario.script?.length ?? 0) === 0 && simulator === scriptOnlySimulator)
    return "needs the patient simulator (#31)";
  return undefined;
}

export async function runScenarioTrial(
  scenario: Scenario,
  options: RunScenarioOptions,
): Promise<TrialResult> {
  const trial = options.trial ?? 1;
  const simulator = options.simulator ?? scriptOnlySimulator;
  const reason = skipReason(scenario, simulator);
  if (reason !== undefined) return skipped(trial, reason, simulator.name);

  const { agent } = options;
  const env = await createTrialEnvironment(scenario, {
    trial,
    ...(agent.registry === undefined ? {} : { registry: agent.registry }),
  });
  const firstName = firstNameOf(env.before.patients, env.patientId);
  const system = promptFor(agent.systemPrompt, env.clock.now(), firstName);

  const history: LlmMessage[] = [];
  const events: TranscriptEvent[] = [];
  const outcomes: TurnOutcome[] = [];
  const turnDurationsMs: number[] = [];
  let usage = zeroUsage();
  let llmCalls = 0;
  let llmRetries = 0;
  let costUsd = 0;
  const simulatorCost: SimulatorCost = zeroSimulatorCost();
  const simulatorTurns: RecordedSimulatorTurn[] = [];
  const addSimulatorCost = (cost: SimulatorCost | undefined) => {
    if (cost === undefined) return;
    simulatorCost.usage = addUsage(simulatorCost.usage, cost.usage);
    simulatorCost.costUsd += cost.costUsd;
    simulatorCost.llmCalls += cost.llmCalls;
  };
  let stoppedBecause = "max_turns";
  let error: string | undefined;
  const started = performance.now();
  const script = scenario.script ?? [];

  for (let turn = 1; turn <= scenario.max_turns; turn++) {
    let message: string;
    let scriptStep: number | undefined;
    const scripted = script[turn - 1];
    if (scripted !== undefined) {
      message = scripted;
      scriptStep = turn;
    } else {
      let next;
      try {
        next = await simulator.next({
          scenario,
          trial,
          events,
          turn,
          lastAssistantText: assistantTexts(events).at(-1) ?? "",
        });
      } catch (simError) {
        // A simulator failure is the harness's, not the agent's: `error`, never `fail` (#31).
        if (simError instanceof SimulatorError) addSimulatorCost(simError.cost);
        error = `simulator: ${errorReason(simError)}`;
        stoppedBecause = "error";
        break;
      }
      addSimulatorCost(next.cost);
      if ("stop" in next) {
        simulatorTurns.push({ turn, stop: next.stop, ...rejectedOf(next) });
        stoppedBecause = next.stop;
        break;
      }
      simulatorTurns.push({ turn, message: next.message, ...rejectedOf(next) });
      message = next.message;
    }

    const t0 = performance.now();
    const result = await runAgentTurn({
      history,
      userMessage: message,
      system,
      executor: env.executor,
      llm: agent.llm,
      profile: agent.profile,
      clock: env.clock,
      conversationId: env.conversationId,
      turnId: env.uuid(),
    });
    turnDurationsMs.push(Math.round(performance.now() - t0));
    history.push(...result.newMessages);
    events.push(...turnEvents(turn, result.newMessages, result.trace.toolCalls, scriptStep));
    outcomes.push(result.outcome);
    usage = addUsage(usage, result.usage);
    llmCalls += result.trace.llmCalls.length;
    llmRetries += result.trace.llmCalls.filter((c) => c.attempt > 0).length;
    costUsd += estimateCostUsd(agent.profile, result.usage);
    if (result.outcome === "error") {
      error = errorReason(result.error);
      stoppedBecause = "error";
      break;
    }
  }

  const graders = gradeScenario({
    scenario,
    events,
    before: env.before,
    after: env.repos.snapshot(),
    patientId: env.patientId,
    outcomes,
    harnessWrites: {
      appointmentIds: env.faultsFired.flatMap((f) => (f.takenAppointmentId ? [f.takenAppointmentId] : [])),
      slotIds: env.faultsFired.flatMap((f) => (f.takenSlotId ? [f.takenSlotId] : [])),
    },
  });
  const passed = trialPassed(graders);
  return {
    kind: "scenario",
    trial,
    status: error !== undefined ? "error" : passed ? "pass" : "fail",
    ...(error === undefined ? {} : { reason: error }),
    graders,
    safetyViolations: safetyViolations(graders),
    events,
    turns: outcomes.length,
    outcomes,
    stoppedBecause,
    simulator: simulator.name,
    simulatorTurns,
    usage,
    llmCalls,
    llmRetries,
    costUsd: costUsd + simulatorCost.costUsd,
    simulatorCost,
    durationMs: Math.round(performance.now() - started),
    turnDurationsMs,
  };
}
