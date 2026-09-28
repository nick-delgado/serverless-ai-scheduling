/**
 * Spike S-1 (#9): measure a realistic tool-use round-trip on Claude in Amazon Bedrock (Mantle)
 * for each candidate model, and record latency, tokens, cache behaviour, and cost.
 *
 * One "turn" = call A (patient asks → model emits tool_use) + canned tool_result + call B
 * (model writes the answer the patient would see). Models run round-robin so time-of-day
 * noise is shared, and each model's cached prefix stays inside the 5-minute TTL.
 *
 * Usage: AWS_PROFILE=sched-dev npx tsx run.ts [--backend mantle|runtime] [--runs 10] [--budget 1.5]
 *        [--models opus-5,sonnet-5,haiku-4.5]
 *
 * Backends: `mantle` = Claude in Amazon Bedrock (bedrock-mantle endpoint, AnthropicBedrockMantle);
 *           `runtime` = bedrock-runtime InvokeModel via US inference profiles (AnthropicBedrock).
 *
 * Throwaway spike code: informs ADR-002, not production (see packages/agent for the real loop).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock, { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

import { DYNAMIC_CONTEXT, SYSTEM_PROMPT, TOOLS, USER_MESSAGE, cannedAvailability } from "./fixture";

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

interface ModelConfig {
  key: string;
  /** Candidate model IDs per backend, tried in order until one is accepted. */
  ids: { mantle: string[]; runtime: string[] };
  /** Extra request params (effort/thinking) for this model. */
  params: Partial<Anthropic.MessageStreamParams>;
  /** Anthropic list prices (USD per million tokens), used only as an estimate for Bedrock. */
  price: { input: number; output: number };
}

const MODELS: ModelConfig[] = [
  {
    key: "opus-5",
    ids: { mantle: ["anthropic.claude-opus-5"], runtime: ["us.anthropic.claude-opus-5"] },
    params: { output_config: { effort: "medium" } },
    price: { input: 5, output: 25 },
  },
  {
    key: "sonnet-5",
    ids: { mantle: ["anthropic.claude-sonnet-5"], runtime: ["us.anthropic.claude-sonnet-5"] },
    params: { output_config: { effort: "medium" } },
    price: { input: 2, output: 10 },
  },
  {
    // Previous-generation Sonnet: entitled on this account while Opus 5 / Sonnet 5 await AWS (see ADR-002).
    key: "sonnet-4.6",
    ids: { mantle: ["anthropic.claude-sonnet-4-6"], runtime: ["us.anthropic.claude-sonnet-4-6"] },
    // Sonnet 4.6 needs adaptive thinking set explicitly (omitting it runs without thinking).
    params: { thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
    price: { input: 3, output: 15 },
  },
  {
    key: "haiku-4.5",
    ids: {
      mantle: ["anthropic.claude-haiku-4-5"],
      runtime: ["us.anthropic.claude-haiku-4-5-20251001-v1:0"],
    },
    params: {}, // no effort parameter on Haiku 4.5; thinking off
    price: { input: 1, output: 5 },
  },
];

const CACHE_WRITE_MULT = 1.25; // 5-minute TTL
const CACHE_READ_MULT = 0.1;

const { values: args } = parseArgs({
  options: {
    backend: { type: "string", default: "mantle" },
    runs: { type: "string", default: "10" },
    // New accounts start with low Bedrock quotas (we hit 429s after ~15 calls); pace calls and retry.
    "pace-ms": { type: "string", default: "2000" },
    budget: { type: "string", default: "1.5" },
    models: { type: "string", default: MODELS.map((m) => m.key).join(",") },
    region: { type: "string", default: process.env.AWS_REGION ?? "us-east-1" },
    profile: { type: "string", default: process.env.AWS_PROFILE ?? "sched-dev" },
  },
});
const RUNS = Number(args.runs);
const BUDGET_USD = Number(args.budget);
const PACE_MS = Number(args["pace-ms"]);
const MAX_RETRIES = 6; // SDK retries 429/5xx with exponential backoff
const selected = MODELS.filter((m) => args.models.split(",").includes(m.key));

const BACKEND = args.backend === "runtime" ? "runtime" : "mantle";
// Both clients expose the same Messages API surface; the runtime client reads AWS_PROFILE from the env.
const client =
  BACKEND === "mantle"
    ? new AnthropicBedrockMantle({
        awsRegion: args.region,
        awsProfile: args.profile,
        maxRetries: MAX_RETRIES,
      })
    : new AnthropicBedrock({ awsRegion: args.region, maxRetries: MAX_RETRIES });

// ---------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------

interface CallMetrics {
  stopReason: string | null;
  msToMessageStart: number | null;
  msToFirstBlock: number | null;
  msToFirstText: number | null;
  msToToolUseStart: number | null;
  msTotal: number;
  usage: {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
  };
  blockTypes: string[];
}

interface TurnResult {
  model: string;
  modelId: string;
  run: number;
  ok: boolean;
  error?: string;
  callA?: CallMetrics;
  callB?: CallMetrics;
  toolName?: string;
  toolInput?: unknown;
  finalText?: string;
  turnMs?: number;
  costUsd: number;
}

async function timedStream(
  params: Anthropic.MessageStreamParams,
): Promise<{ metrics: CallMetrics; message: Anthropic.Message }> {
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  const m: Omit<CallMetrics, "stopReason" | "msTotal" | "usage" | "blockTypes"> = {
    msToMessageStart: null,
    msToFirstBlock: null,
    msToFirstText: null,
    msToToolUseStart: null,
  };
  const stream = client.messages.stream(params);
  for await (const event of stream) {
    if (event.type === "message_start") m.msToMessageStart ??= since();
    if (event.type === "content_block_start") {
      m.msToFirstBlock ??= since();
      if (event.content_block.type === "tool_use") m.msToToolUseStart ??= since();
    }
    if (event.type === "content_block_delta" && event.delta.type === "text_delta")
      m.msToFirstText ??= since();
  }
  const message = await stream.finalMessage();
  const u = message.usage;
  return {
    message,
    metrics: {
      ...m,
      stopReason: message.stop_reason,
      msTotal: since(),
      usage: {
        input: u.input_tokens,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens,
      },
      blockTypes: message.content.map((b) => b.type),
    },
  };
}

function cost(model: ModelConfig, c: CallMetrics): number {
  const { input, output } = model.price;
  return (
    (c.usage.input * input +
      c.usage.cacheWrite * input * CACHE_WRITE_MULT +
      c.usage.cacheRead * input * CACHE_READ_MULT +
      c.usage.output * output) /
    1_000_000
  );
}

const resolvedId = new Map<string, string>();

async function runTurn(model: ModelConfig, run: number): Promise<TurnResult> {
  const base = {
    max_tokens: 4096,
    tools: TOOLS,
    system: [
      // Stable, cacheable prefix: tools + this block. The breakpoint caches everything up to here.
      { type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } },
      // Volatile context after the breakpoint (today's date, patient first name).
      { type: "text" as const, text: DYNAMIC_CONTEXT },
    ],
    ...model.params,
  };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: USER_MESSAGE }];

  const known = resolvedId.get(model.key);
  const candidates = known ? [known] : model.ids[BACKEND];
  let lastErr: unknown;
  for (const modelId of candidates) {
    const result: TurnResult = { model: model.key, modelId, run, ok: false, costUsd: 0 };
    try {
      const a = await timedStream({ ...base, model: modelId, messages });
      resolvedId.set(model.key, modelId);
      result.callA = a.metrics;
      result.costUsd += cost(model, a.metrics);

      const toolUse = a.message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (a.message.stop_reason !== "tool_use" || !toolUse) {
        result.error = `no tool call (stop_reason=${a.message.stop_reason})`;
        result.finalText = a.message.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        return result;
      }
      result.toolName = toolUse.name;
      result.toolInput = toolUse.input;

      const b = await timedStream({
        ...base,
        model: modelId,
        messages: [
          ...messages,
          { role: "assistant", content: a.message.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(cannedAvailability) },
            ],
          },
        ],
      });
      result.callB = b.metrics;
      result.costUsd += cost(model, b.metrics);
      result.finalText = b.message.content
        .filter((blk): blk is Anthropic.TextBlock => blk.type === "text")
        .map((blk) => blk.text)
        .join("");
      result.turnMs = a.metrics.msTotal + b.metrics.msTotal;
      result.ok = b.message.stop_reason === "end_turn";
      if (!result.ok) result.error = `call B stop_reason=${b.message.stop_reason}`;
      return result;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError;
      if (!resolvedId.has(model.key) && retryable && modelId !== candidates.at(-1)) continue; // try next ID
      result.error = err instanceof Anthropic.APIError ? `${err.status}: ${err.message}` : String(err);
      return result;
    }
  }
  return { model: model.key, modelId: "?", run, ok: false, error: String(lastErr), costUsd: 0 };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}
const fmtMs = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(2)} s`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number");

function summarize(results: TurnResult[], startedAt: string, callerArn: string): string {
  const lines: string[] = [];
  lines.push(`# Spike S-1 results — ${startedAt}`, "");
  lines.push(
    `Backend \`${BACKEND}\` · region \`${args.region}\` · caller \`${callerArn}\` · ${RUNS} runs/model · round-robin order`,
    "",
  );
  lines.push(
    "One turn = call A (question → `tool_use`) + canned `tool_result` + call B (answer). " +
      "Latency measured client-side from a laptop (includes network to us-east-1).",
    "",
  );
  lines.push(
    "| Model | ID accepted | OK / runs | Tool called | A: first block p50 / p95 | A: total p50 / p95 | B: first text p50 / p95 | Turn p50 / p95 | Avg in / cache-write / cache-read / out tokens (A+B) | Est. cost / turn |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const model of selected) {
    const rs = results.filter((r) => r.model === model.key);
    const ok = rs.filter((r) => r.ok);
    const aFirst = nums(ok.map((r) => r.callA?.msToFirstBlock));
    const aTotal = nums(ok.map((r) => r.callA?.msTotal));
    const bText = nums(ok.map((r) => r.callB?.msToFirstText));
    const turn = nums(ok.map((r) => r.turnMs));
    const tok = (f: (c: CallMetrics) => number) =>
      Math.round(mean(ok.map((r) => (r.callA ? f(r.callA) : 0) + (r.callB ? f(r.callB) : 0))));
    const tools = [...new Set(rs.map((r) => r.toolName ?? "none"))].join(", ");
    lines.push(
      `| ${model.key} | \`${rs.find((r) => r.ok)?.modelId ?? rs[0]?.modelId ?? "?"}\` | ${ok.length} / ${rs.length} | ${tools} | ` +
        `${fmtMs(pct(aFirst, 50))} / ${fmtMs(pct(aFirst, 95))} | ${fmtMs(pct(aTotal, 50))} / ${fmtMs(pct(aTotal, 95))} | ` +
        `${fmtMs(pct(bText, 50))} / ${fmtMs(pct(bText, 95))} | ${fmtMs(pct(turn, 50))} / ${fmtMs(pct(turn, 95))} | ` +
        `${tok((c) => c.usage.input)} / ${tok((c) => c.usage.cacheWrite)} / ${tok((c) => c.usage.cacheRead)} / ${tok((c) => c.usage.output)} | ` +
        `$${mean(ok.map((r) => r.costUsd)).toFixed(4)} |`,
    );
  }
  lines.push("", `**Total estimated spend:** $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(3)}`, "");

  lines.push("## Cache behaviour", "");
  for (const model of selected) {
    const rs = results.filter((r) => r.model === model.key && r.callA);
    const firstA = rs[0]?.callA?.usage;
    const laterReads = nums(rs.slice(1).map((r) => r.callA?.usage.cacheRead));
    lines.push(
      `- **${model.key}:** run 1 call A wrote ${firstA?.cacheWrite ?? 0} tokens / read ${firstA?.cacheRead ?? 0}; ` +
        `later call A cache reads: ${laterReads.length ? `min ${Math.min(...laterReads)}, max ${Math.max(...laterReads)}` : "n/a"}; ` +
        `call B cache reads (mean): ${Math.round(mean(nums(rs.map((r) => r.callB?.usage.cacheRead))))}.`,
    );
  }
  lines.push("", "## Tool inputs and sample answers", "");
  for (const model of selected) {
    const r = results.find((x) => x.model === model.key && x.ok);
    const inputs = [
      ...new Set(
        results.filter((x) => x.model === model.key && x.toolInput).map((x) => JSON.stringify(x.toolInput)),
      ),
    ];
    lines.push(`### ${model.key}`, "", "Distinct tool inputs:", "", ...inputs.map((i) => `- \`${i}\``), "");
    if (r?.finalText)
      lines.push("Sample answer (run " + r.run + "):", "", "> " + r.finalText.replace(/\n/g, "\n> "), "");
  }
  const errors = results.filter((r) => r.error);
  if (errors.length) {
    lines.push("## Errors / non-tool outcomes", "");
    for (const e of errors) lines.push(`- ${e.model} run ${e.run} (\`${e.modelId}\`): ${e.error}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  const { execFileSync } = await import("node:child_process");
  let callerArn = "unknown";
  try {
    callerArn = execFileSync(
      "aws",
      ["sts", "get-caller-identity", "--profile", args.profile, "--query", "Arn", "--output", "text"],
      { encoding: "utf8" },
    )
      .trim()
      .replace(/:\d{12}:/, ":<account>:");
  } catch {
    /* identity is informational only */
  }

  const results: TurnResult[] = [];
  let spent = 0;
  outer: for (let run = 1; run <= RUNS; run++) {
    for (const model of selected) {
      if (spent >= BUDGET_USD) {
        console.error(`Budget guard: $${spent.toFixed(3)} ≥ $${BUDGET_USD}; stopping.`);
        break outer;
      }
      if (results.length > 0) await new Promise((res) => setTimeout(res, PACE_MS));
      const r = await runTurn(model, run);
      spent += r.costUsd;
      results.push(r);
      console.log(
        `${model.key.padEnd(10)} run ${String(run).padStart(2)}  ${r.ok ? "ok " : "ERR"}  ` +
          `turn ${r.turnMs ? (r.turnMs / 1000).toFixed(2) + "s" : "—"}  ` +
          `cacheRead(A) ${r.callA?.usage.cacheRead ?? "—"}  $${r.costUsd.toFixed(4)}  total $${spent.toFixed(3)}` +
          (r.error ? `  (${r.error})` : ""),
      );
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const stamp = `${BACKEND}-${startedAt.replace(/[:.]/g, "-")}`;
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(
    join(here, "results", `raw-${stamp}.json`),
    JSON.stringify({ startedAt, callerArn, results }, null, 2),
  );
  const summary = summarize(results, startedAt, callerArn);
  writeFileSync(join(here, "results", `summary-${stamp}.md`), summary);
  console.log("\n" + summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
