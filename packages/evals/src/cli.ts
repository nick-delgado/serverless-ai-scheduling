/**
 * `npm run evals -- --suite smoke|full --mode l1|scenario --profile <name> --trials <k>`
 *
 * Live runs call Bedrock (cost real money): every call goes through the shared per-model rate limiter
 * with 429 backoff, a budget guard stops the run at `--max-cost`, and the estimated cost is printed
 * before the first call. Results: `packages/evals/results/<timestamp>-<mode>-<suite>-<profile>.{json,md}`
 * (git-ignored).
 *
 * Other flags: `--filter <substring>[,<substring>…]`, `--max-cost <usd>` (default 1), `--dry-run`
 * (list cases and the estimate, no calls), `--out <dir>`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ConverseLlmClient, estimateCostUsd, resolveModelProfile } from "@sched/agent";

import { l1Request } from "./l1";
import { loadScenarios, selectSuite, type Suite } from "./loader";
import { rateLimited } from "./rate-limit";
import { skipReason } from "./runner";
import type { L1Case, Scenario } from "./schema";
import { scriptOnlySimulator } from "./simulator";
import { markdownSummary, runSuite, type Mode } from "./suite";
import { interimSystemPrompt } from "./system-prompt";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

function fail(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      suite: { type: "string", default: "smoke" },
      mode: { type: "string", default: "l1" },
      profile: { type: "string" },
      trials: { type: "string", default: "1" },
      filter: { type: "string" },
      "max-cost": { type: "string", default: "1" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string", default: RESULTS_DIR },
    },
    strict: true,
  });
  const suite = values.suite as Suite;
  if (suite !== "smoke" && suite !== "full") fail(`--suite must be smoke or full, got ${suite}`);
  const mode = values.mode as Mode;
  if (mode !== "l1" && mode !== "scenario") fail(`--mode must be l1 or scenario, got ${mode}`);
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1) fail(`--trials must be a positive integer`);
  const maxCostUsd = Number(values["max-cost"]);
  if (!(maxCostUsd > 0)) fail(`--max-cost must be a positive number of USD`);
  const profile = resolveModelProfile(values.profile);

  const loaded = loadScenarios();
  const pool: (Scenario | L1Case)[] = mode === "l1" ? loaded.l1 : loaded.scenarios;
  const filters =
    values.filter
      ?.split(",")
      .map((f) => f.trim())
      .filter(Boolean) ?? [];
  const cases = selectSuite(pool, suite).filter(
    (c) => filters.length === 0 || filters.some((f) => c.id.includes(f)),
  );
  if (cases.length === 0) fail("no cases match");

  // Estimate before spending: L1 is one call per trial (input ≈ request bytes / 4, output ≈ 300 tokens).
  const runnable =
    mode === "l1" ? cases : cases.filter((c) => skipReason(c as Scenario, scriptOnlySimulator) === undefined);
  let estimate = 0;
  if (mode === "l1") {
    for (const c of cases as L1Case[]) {
      const req = l1Request(c, profile, interimSystemPrompt(new Date(c.clock), "Patient"));
      const inputTokens = Math.ceil(JSON.stringify(req).length / 4);
      estimate +=
        estimateCostUsd(profile, {
          inputTokens,
          outputTokens: 300,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }) * trials;
    }
  } else {
    // Scripted turns only until #31: assume 3 calls per scripted turn at ~4k input / 400 output tokens.
    for (const c of runnable as Scenario[])
      estimate +=
        estimateCostUsd(profile, {
          inputTokens: 4000,
          outputTokens: 400,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }) *
        3 *
        (c.script?.length ?? 0) *
        trials;
  }
  console.log(
    `evals: ${mode} / ${suite} / ${profile.name} (${profile.modelId}): ${cases.length} case(s), ${runnable.length} runnable, ${trials} trial(s) each. Estimated cost ≈ $${estimate.toFixed(4)} (budget guard $${maxCostUsd}).`,
  );
  if (mode === "scenario")
    for (const c of cases) {
      const why = skipReason(c as Scenario, scriptOnlySimulator);
      if (why !== undefined) console.log(`  skip ${c.id}: ${why}`);
    }
  if (values["dry-run"]) return;

  const llm = rateLimited(new ConverseLlmClient({ maxAttempts: 1 }), {
    onRetry: ({ modelId, attempt, delayMs, error }) =>
      console.log(`  retry ${attempt} on ${modelId} in ${delayMs} ms (${(error as Error).name})`),
  });
  const report = await runSuite(cases, {
    mode,
    suite,
    llm,
    llmName: "converse",
    profile,
    trials,
    maxCostUsd,
    onTrial: (id, t) =>
      console.log(
        `  ${t.status.padEnd(5)} ${id}#${t.trial}  $${t.costUsd.toFixed(5)}  ${t.durationMs} ms${
          t.status === "fail"
            ? `  ${t.graders
                .filter((g) => g.status === "fail")
                .map((g) => g.name)
                .join(", ")}`
            : ""
        }${"reason" in t && t.reason ? `  (${t.reason})` : ""}`,
      ),
  });
  report.rateLimit = { ...llm.stats };

  mkdirSync(values.out, { recursive: true });
  const stamp = report.startedAt.replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  const base = join(values.out, `${stamp}-${mode}-${suite}-${profile.name}`);
  const md = markdownSummary(report);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.md`, `${md}\n`);
  console.log(`\n${md}\n\nevals: wrote ${base}.json`);
  if (report.summary.safetyViolations > 0 || report.summary.errored > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
