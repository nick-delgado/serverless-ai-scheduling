/**
 * Spike S-1c (#60): does the provider-neutral LLM layer hold up live? Runs N real agent turns per model
 * profile through the production code path (`runAgentTurn` + `ConverseLlmClient`), then a few targeted
 * checks. Throwaway measurement code; results feed ADR-010.
 *
 *   AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx run.ts --runs 5 --budget 1
 *
 * One turn = the patient asks for dermatology openings → the model calls check_availability (canned
 * result) → the model answers. Every call is paced to the model's on-demand RPM quota.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  ConverseLlmClient,
  estimateCostUsd,
  type LlmMessage,
  MODEL_PROFILES,
  type ModelProfile,
  type ModelProfileName,
  runAgentTurn,
  type ToolExecutor,
} from "@sched/agent";
import { type ChatStreamEvent, toolDefinitionsForModel, type TurnTrace, visibleText } from "@sched/contracts";

import {
  DYNAMIC_CONTEXT,
  SYSTEM_PROMPT,
  USER_MESSAGE,
  cannedAvailability,
} from "../s1-bedrock-tool-latency/fixture";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    budget: { type: "string", default: "1" },
    "skip-checks": { type: "boolean", default: false },
    models: { type: "string", default: "sonnet-4.6,haiku-4.5,nova-2-lite,nova-pro,gpt-oss-120b,gpt-oss-20b" },
  },
});
const RUNS = Number(args.runs);
const BUDGET = Number(args.budget);
const MODELS = args.models.split(",") as ModelProfileName[];

/** On-demand requests per minute this account gets per model (quota figures as of 2026-09-29). */
const rpmFor = (p: ModelProfile): number => {
  if (p.family === "anthropic.claude") return 10;
  if (p.family === "openai.gpt-oss") return 100;
  return p.name === "nova-pro" ? 25 : 20;
};

const llm = new ConverseLlmClient({ maxAttempts: 6 });
const clock = { now: () => new Date() };
const system = { version: "s1c-fixture", stable: SYSTEM_PROMPT, dynamic: DYNAMIC_CONTEXT };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let spent = 0;

function executor(): ToolExecutor & { calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  return {
    definitions: toolDefinitionsForModel(),
    calls,
    async execute(call) {
      calls.push({ name: call.name, input: call.input });
      if (call.name === "check_availability") return { ok: true, output: cannedAvailability };
      return { ok: false, error: { error: { code: "NOT_FOUND", message: "Not part of this spike." } } };
    },
  };
}

/** Paces calls per model: never more than the model's RPM, with a 10% margin. */
const lastCall = new Map<string, number>();
async function pace(profile: ModelProfile, calls: number) {
  const gap = (60_000 / rpmFor(profile)) * 1.1 * calls;
  const wait = (lastCall.get(profile.name) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(profile.name, Date.now());
}

interface TurnRecord {
  model: ModelProfileName;
  run: number;
  outcome: string;
  correctToolCall: boolean;
  toolInput: unknown;
  toolNames: string[];
  /** A reasoning/thinking tag reached the patient-visible text. */
  inlineTagLeak: boolean;
  calls: {
    stopReason: string;
    providerStopReason?: string;
    ttftMs?: number;
    durationMs: number;
    usage: TurnTrace["usage"];
  }[];
  turnMs: number;
  textDeltas: number;
  firstToLastDeltaMs: number;
  reasoningBlocks: number;
  signedReasoningReplayed: boolean;
  costUsd: number;
  answer: string;
  error?: string;
}

async function turn(
  profile: ModelProfile,
  run: number,
  history: LlmMessage[] = [],
  userMessage = USER_MESSAGE,
) {
  await pace(profile, 2);
  const events: { t: number; e: ChatStreamEvent }[] = [];
  const exec = executor();
  const t0 = performance.now();
  const result = await runAgentTurn({
    history,
    userMessage,
    system,
    executor: exec,
    llm,
    profile,
    clock,
    onEvent: (e) => events.push({ t: performance.now(), e }),
    conversationId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
  });
  const turnMs = Math.round(performance.now() - t0);
  const deltas = events.filter((x) => x.e.type === "text_delta");
  const reasoning = result.newMessages.flatMap((m) => m.content).filter((b) => b.type === "reasoning");
  const cost = estimateCostUsd(profile, result.usage);
  spent += cost;
  const call = exec.calls.find((c) => c.name === "check_availability");
  const input = call?.input as
    { specialty?: string; date_range?: { start_date?: string; end_date?: string } } | undefined;
  const record: TurnRecord = {
    model: profile.name,
    run,
    outcome: result.outcome,
    correctToolCall:
      input?.specialty === "dermatology" &&
      (input.date_range?.start_date ?? "") <= "2026-10-13" &&
      (input.date_range?.end_date ?? "") >= "2026-10-13",
    toolInput: call?.input,
    toolNames: exec.calls.map((c) => c.name),
    inlineTagLeak: /<\/?(reasoning|thinking)>/.test(visibleText(events.map((x) => x.e))),
    calls: result.trace.llmCalls.map((c) => ({
      stopReason: c.stopReason,
      ...(c.providerStopReason ? { providerStopReason: c.providerStopReason } : {}),
      ...(c.ttftMs === undefined ? {} : { ttftMs: c.ttftMs }),
      durationMs: c.durationMs,
      usage: c.usage,
    })),
    turnMs,
    textDeltas: deltas.length,
    firstToLastDeltaMs: Math.round((deltas.at(-1)?.t ?? 0) - (deltas[0]?.t ?? 0)),
    reasoningBlocks: reasoning.length,
    // The loop sends this turn's reasoning back on its second call; the call succeeding is the round-trip.
    signedReasoningReplayed:
      result.trace.llmCalls.length >= 2 &&
      result.outcome === "completed" &&
      reasoning.some(
        (b) => b.type === "reasoning" && typeof b.signature === "string" && b.signature.length > 0,
      ),
    costUsd: Number(cost.toFixed(5)),
    answer: visibleText(events.map((x) => x.e)),
    ...(result.outcome === "error"
      ? { error: String((result.error as Error)?.message ?? result.error) }
      : {}),
  };
  return { record, result };
}

const records: TurnRecord[] = [];
const checks: Record<string, unknown> = {};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

for (let run = 0; run < RUNS; run++) {
  for (const name of MODELS) {
    if (spent >= BUDGET) throw new Error(`Budget reached: $${spent.toFixed(4)}`);
    const { record } = await turn(MODEL_PROFILES[name], run);
    records.push(record);
    const c = record.calls;
    console.log(
      `${name.padEnd(13)} run ${run} ${record.outcome.padEnd(9)} tool=${record.correctToolCall ? "ok" : "BAD"} ` +
        `turn=${record.turnMs}ms ttft=${c.map((x) => x.ttftMs ?? "-").join("/")} ` +
        `in/cr/cw/out=${c.map((x) => `${x.usage.inputTokens}/${x.usage.cacheReadTokens}/${x.usage.cacheWriteTokens}/${x.usage.outputTokens}`).join(" ")} ` +
        `deltas=${record.textDeltas} reasoning=${record.reasoningBlocks}${record.signedReasoningReplayed ? " (signed, replayed)" : ""} $${record.costUsd} tools=${record.toolNames.join(",")}${record.inlineTagLeak ? " TAG-LEAK" : ""}`,
    );
    if (record.error) console.log(`  error: ${record.error}`);
  }
}

if (!args["skip-checks"]) {
  // Check: Sonnet's signed reasoning, stored in history, is accepted by the next turn on Sonnet (same model)
  // and by Haiku (same family, different model).
  {
    const first = await turn(MODEL_PROFILES["sonnet-4.6"], 100);
    const history = first.result.newMessages;
    const signed = history
      .flatMap((m) => m.content)
      .filter((b) => b.type === "reasoning" && b.signature).length;
    const sonnetNext = await turn(
      MODEL_PROFILES["sonnet-4.6"],
      101,
      history,
      "Yes, the 2:30 with Dr. Lee please. What do I need to bring?",
    );
    const haikuNext = await turn(
      MODEL_PROFILES["haiku-4.5"],
      102,
      history,
      "Yes, the 2:30 with Dr. Lee please. What do I need to bring?",
    );
    // And a different family (reasoning dropped from the request copy).
    const ossNext = await turn(
      MODEL_PROFILES["gpt-oss-120b"],
      103,
      history,
      "Yes, the 2:30 with Dr. Lee please. What do I need to bring?",
    );
    checks.crossTurnReplay = {
      signedReasoningBlocksInHistory: signed,
      sonnetNextTurn: sonnetNext.record.outcome,
      haikuNextTurn: haikuNext.record.outcome,
      gptOssNextTurn: ossNext.record.outcome,
    };
    records.push(first.record, sonnetNext.record, haikuNext.record, ossNext.record);
    console.log("crossTurnReplay", checks.crossTurnReplay);
  }

  // Check: gpt-oss actually reads `reasoning_effort` (an invalid value must be rejected, not ignored).
  {
    const bogus: ModelProfile = {
      ...MODEL_PROFILES["gpt-oss-20b"],
      modelFields: { reasoning_effort: "bogus" },
    };
    const { record } = await turn(bogus, 200);
    checks.gptOssReasoningEffortValidated = { outcome: record.outcome, error: record.error ?? null };
    console.log("gptOssReasoningEffortValidated", checks.gptOssReasoningEffortValidated);
  }
}

writeFileSync(
  `results/raw-${stamp}.json`,
  JSON.stringify({ runs: RUNS, spentUsd: spent, checks, records }, null, 2),
);

// Summary table
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};
const lines = [
  `# S-1c results (${stamp})`,
  "",
  `N=${RUNS} turns per profile. Estimated spend: $${spent.toFixed(4)}.`,
  "",
  "| Profile | Turns OK | Correct tool call | Tag leaks | Turn p50 / p95 (ms) | Call A TTFT p50 (ms) | Answer TTFT p50 (ms) | In / cache read / cache write / out per turn (mean) | Cache read on call B | Text deltas per turn (mean) | Reasoning replayed | $ per turn (mean) |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
];
for (const name of MODELS) {
  const rs = records.filter((r) => r.model === name && r.run < RUNS);
  const ok = rs.filter((r) => r.outcome === "completed");
  const mean = (f: (r: TurnRecord) => number) =>
    Math.round(rs.reduce((s, r) => s + f(r), 0) / Math.max(1, rs.length));
  const sum = (r: TurnRecord, k: keyof TurnTrace["usage"]) => r.calls.reduce((s, c) => s + c.usage[k], 0);
  lines.push(
    `| ${name} | ${ok.length}/${rs.length} | ${rs.filter((r) => r.correctToolCall).length}/${rs.length} | ${rs.filter((r) => r.inlineTagLeak).length} | ` +
      `${pct(
        ok.map((r) => r.turnMs),
        50,
      )} / ${pct(
        ok.map((r) => r.turnMs),
        95,
      )} | ` +
      `${pct(
        ok.map((r) => r.calls[0]?.ttftMs ?? NaN),
        50,
      )} | ${pct(
        ok.map((r) => r.calls.at(-1)?.ttftMs ?? NaN),
        50,
      )} | ` +
      `${mean((r) => sum(r, "inputTokens"))} / ${mean((r) => sum(r, "cacheReadTokens"))} / ${mean((r) => sum(r, "cacheWriteTokens"))} / ${mean((r) => sum(r, "outputTokens"))} | ` +
      `${rs.filter((r) => (r.calls[1]?.usage.cacheReadTokens ?? 0) > 0).length}/${rs.length} | ` +
      `${mean((r) => r.textDeltas)} | ${rs.filter((r) => r.signedReasoningReplayed).length}/${rs.length} (${rs.filter((r) => r.reasoningBlocks > 0).length} with reasoning) | ` +
      `${(rs.reduce((s, r) => s + r.costUsd, 0) / Math.max(1, rs.length)).toFixed(5)} |`,
  );
}
lines.push("", "## Checks", "", "```json", JSON.stringify(checks, null, 2), "```", "");
writeFileSync(`results/summary-${stamp}.md`, lines.join("\n"));
console.log(lines.join("\n"));
