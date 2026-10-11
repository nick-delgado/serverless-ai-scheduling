/**
 * Spike (#37, r1/Q-4 (a)): does a refusal on the production profile really fall back to its
 * `REFUSAL_FALLBACKS` partner, live on Bedrock? Never verified live since PR #53.
 *
 * Two turns through `runAgentTurn`, with the in-memory repositories, the `clinic-default` fixture and its
 * synthetic patient Walter Haines (frozen at the fixture's `suggestedNow`):
 *   - Turn 1 runs live on the chosen profile.
 *   - Turn 2's first model call returns `scriptedRefusal()` from a wrapper `LlmClient`; every later call goes
 *     to Bedrock through `ConverseLlmClient`. The loop then retries on `fallbackProfileFor(chosen)`, with
 *     turn 1's history in the request.
 * "Confirmed" means turn 2 ends with outcome `completed`, and its calls after the refusal use the fallback's model ID.
 * It prints each call's model ID and stop reason, and each turn's outcome, and writes them to
 * `results/<stamp>-<profile>.md`.
 *
 * Usage (from the repo root; calls Bedrock, a few cents):
 *   AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx spikes/refusal-fallback/run.ts [--profile <name>]
 *
 * Throwaway spike code: no tests, not production. Exit code 0 when confirmed, 1 otherwise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ConverseLlmClient,
  DEFAULT_MODEL_PROFILE,
  buildSystemPrompt,
  estimateCostUsd,
  fallbackProfileFor,
  resolveModelProfile,
  runAgentTurn,
  scriptedRefusal,
  type AgentTurnResult,
  type LlmCallOptions,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamHandlers,
} from "@sched/agent";
import type { ConversationId, TurnId } from "@sched/contracts";
import {
  createInMemoryRepositories,
  createToolExecutor,
  FrozenClock,
  RecordingNotifier,
  TOOL_REGISTRY,
} from "@sched/tools";
import { FIXTURE_PATIENT_IDS, FIXTURES } from "@sched/tools/fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: { profile: { type: "string", default: DEFAULT_MODEL_PROFILE } },
});

const chosen = resolveModelProfile(args.profile);
const fallback = fallbackProfileFor(chosen);

/** Returns a scripted refusal for its first call while `refuseNext` is set; sends every other call to Bedrock. */
class RefuseOnceLlmClient implements LlmClient {
  refuseNext = false;
  readonly #live = new ConverseLlmClient({ maxAttempts: 6 });

  streamMessage(
    request: LlmRequest,
    handlers?: LlmStreamHandlers,
    options?: LlmCallOptions,
  ): Promise<LlmResponse> {
    if (this.refuseNext) {
      this.refuseNext = false;
      const r = scriptedRefusal();
      return Promise.resolve({
        content: r.content,
        stopReason: r.stopReason,
        providerStopReason: r.providerStopReason,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as LlmResponse);
    }
    return this.#live.streamMessage(request, handlers, options);
  }
}

const fixture = FIXTURES["clinic-default"]();
const clock = new FrozenClock(fixture.suggestedNow);
const patientId = FIXTURE_PATIENT_IDS["pat-walter"];
const conversationId = "c0000000-0000-4000-8000-000000000037" as ConversationId;
const repos = createInMemoryRepositories({ clock, seed: fixture });
const executor = createToolExecutor(TOOL_REGISTRY, {
  patientId,
  conversationId,
  clock,
  repos,
  notifier: new RecordingNotifier(),
});
const system = buildSystemPrompt({ now: clock.now(), patientFirstName: "Walter" });
const llm = new RefuseOnceLlmClient();
const history: LlmMessage[] = [];

async function turn(n: number, text: string, refuseFirst: boolean): Promise<AgentTurnResult> {
  llm.refuseNext = refuseFirst;
  const result = await runAgentTurn({
    history,
    userMessage: text,
    system,
    executor,
    llm,
    profile: chosen,
    clock,
    conversationId,
    turnId: `a0000000-0000-4000-8000-00000000003${n}` as TurnId,
  });
  history.push(...result.newMessages);
  return result;
}

const turns = [
  { text: "Does Dr. Haddad have anything this Thursday afternoon?", refuseFirst: false },
  { text: "What about Friday morning instead?", refuseFirst: true },
];

const lines: string[] = [
  `# Refusal-fallback spike: ${chosen.name} → ${fallback.name}`,
  "",
  `- Chosen: \`${chosen.name}\` (\`${chosen.modelId}\`); fallback: \`${fallback.name}\` (\`${fallback.modelId}\`)`,
  `- Clock ${fixture.suggestedNow} (frozen), fixture \`clinic-default\`, synthetic patient \`pat-walter\``,
  "",
  "| Turn | Call | Attempt | Model ID | Stop reason | Provider stop reason |",
  "|---|---|---|---|---|---|",
];
const outcomes: string[] = [];
let confirmed = true;
let costUsd = 0;
for (const [i, t] of turns.entries()) {
  const r = await turn(i + 1, t.text, t.refuseFirst);
  if (r.outcome === "error") console.error(`turn ${i + 1} error:`, r.error);
  for (const c of r.trace.llmCalls) {
    lines.push(
      `| ${i + 1} | ${c.index} | ${c.attempt} | \`${c.modelId}\` | ${c.stopReason} | ${c.providerStopReason ?? "–"} |`,
    );
    const p = c.modelId === fallback.modelId ? fallback : chosen;
    costUsd += estimateCostUsd(p, c.usage);
  }
  const tools = r.trace.toolCalls.map((tc) => tc.name).join(", ") || "none";
  outcomes.push(
    `- Turn ${i + 1} ("${t.text}"): outcome \`${r.outcome}\`; tools: ${tools}; reply: ${r.text.slice(0, 160).replaceAll("\n", " ")}`,
  );
  if (r.outcome !== "completed") confirmed = false;
  if (t.refuseFirst) {
    const [first, ...rest] = r.trace.llmCalls;
    const afterRefusal = rest.length > 0 && rest.every((c) => c.modelId === fallback.modelId);
    if (first?.stopReason !== "refusal" || !afterRefusal) confirmed = false;
  }
}
lines.push("", ...outcomes, "", `- Estimated cost $${costUsd.toFixed(4)} (list prices)`);
lines.push(
  `- **${confirmed ? "Confirmed" : "Not confirmed"}**: turn 2 ${confirmed ? "completed on" : "did not complete only on"} \`${fallback.modelId}\` after the refusal.`,
);

const out = lines.join("\n");
console.log(out);
mkdirSync(join(here, "results"), { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+/, "");
writeFileSync(join(here, "results", `${stamp}-${chosen.name}.md`), `${out}\n`);
process.exitCode = confirmed ? 0 : 1;
