/**
 * `npm run evals -- --suite smoke|full --mode l1|scenario --profile <name> --trials <k>`
 *
 * `--mode` defaults to `l1` until the simulator (#31) makes scenarios runnable; #34 switches it (owner
 * decision on PR #71, ADR-008 amendment).
 *
 * Live runs call Bedrock (cost real money): every call goes through the shared per-model rate limiter
 * with 429 backoff, a budget guard stops the run at `--max-cost`, and the estimated cost is printed
 * before the first call. Results: `packages/evals/results/<timestamp>-<mode>-<suite>-<profile>.{json,md}`
 * (git-ignored).
 *
 * Scenario mode drives unscripted turns with the LLM patient simulator (#31) on `--simulator-profile`
 * (default `SIMULATOR_MODEL_PROFILE`, else `sonnet-4.6`), through the same rate-limited client as the
 * agent, so both share one per-model quota. `--replay <results.json>` replays a run's recorded
 * simulator turns instead (no simulator calls).
 *
 * Other flags: `--filter <substring>[,<substring>…]`, `--max-cost <usd>` (default 1), `--dry-run`
 * (list cases and the estimate, no calls), `--out <dir>`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConverseLlmClient } from "@sched/agent";

import {
  caseSkipReason,
  CliArgError,
  estimateRunCost,
  exitCodeFor,
  parseCliArgs,
  resultsBasePath,
  selectCases,
  simulatorSetup,
} from "./cli-args";
import { loadScenarios } from "./loader";
import { errorReason } from "./util";
import { rateLimited } from "./rate-limit";
import { failedChecks, markdownSummary, runSuite } from "./suite";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

function fail(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(2);
}

/** Runs one setup step; a `CliArgError` from it is a usage error (exit 2), anything else is rethrown. */
function orUsageError<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof CliArgError) fail(error.message);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = orUsageError(() => parseCliArgs(process.argv.slice(2), RESULTS_DIR));
  const { mode, suite, trials, maxCostUsd, profile } = args;
  const cases = selectCases(loadScenarios(), args);
  if (cases.length === 0) fail("no cases match");

  // One rate-limited client for the agent and the simulator: one quota per model ID (#31).
  const llm = rateLimited(new ConverseLlmClient({ maxAttempts: 1 }), {
    onRetry: ({ modelId, attempt, delayMs, error }) =>
      console.log(`  retry ${attempt} on ${modelId} in ${delayMs} ms (${errorReason(error)})`),
  });
  const setup = orUsageError(() =>
    simulatorSetup(args, {
      llm,
      readReplay: (path) => JSON.parse(readFileSync(path, "utf8")),
    }),
  );
  const { simulator } = setup;

  const skips = cases.flatMap((c) => {
    const why = caseSkipReason(c, simulator);
    return why === undefined ? [] : [`  skip ${c.id}: ${why}`];
  });
  const estimate = estimateRunCost(cases, profile, trials, setup);
  console.log(
    `evals: ${mode} / ${suite} / ${profile.name} (${profile.modelId}): ${cases.length} case(s), ${cases.length - skips.length} runnable, ${trials} trial(s) each${simulator === undefined ? "" : `, simulator ${simulator.name}`}. Estimated cost ≈ $${estimate.toFixed(4)} (budget guard $${maxCostUsd}).`,
  );
  for (const line of skips) console.log(line);
  if (args.dryRun) return;

  const report = await runSuite(cases, {
    mode,
    suite,
    llm,
    llmName: "converse",
    profile,
    trials,
    maxCostUsd,
    rateLimit: llm,
    ...(simulator === undefined ? {} : { simulator }),
    onTrial: (id, t) =>
      console.log(
        `  ${t.status.padEnd(5)} ${id}#${t.trial}  $${t.costUsd.toFixed(5)}  ${t.durationMs} ms  ${failedChecks(t).join("; ")}`,
      ),
  });

  mkdirSync(args.out, { recursive: true });
  const base = resultsBasePath(report, args.out);
  const md = markdownSummary(report);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.md`, `${md}\n`);
  console.log(`\n${md}\n\nevals: wrote ${base}.json`);
  process.exitCode = exitCodeFor(report.summary);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
