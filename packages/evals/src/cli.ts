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
 * Other flags: `--filter <substring>[,<substring>…]`, `--max-cost <usd>` (default 1), `--dry-run`
 * (list cases and the estimate, no calls), `--out <dir>`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
} from "./cli-args";
import { loadScenarios } from "./loader";
import { errorReason } from "./runner";
import { rateLimited } from "./rate-limit";
import { markdownSummary, runSuite } from "./suite";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

function fail(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2), RESULTS_DIR);
  } catch (error) {
    if (error instanceof CliArgError) fail(error.message);
    throw error;
  }
  const { mode, suite, trials, maxCostUsd, profile } = args;
  const cases = selectCases(loadScenarios(), args);
  if (cases.length === 0) fail("no cases match");

  const skips = cases.flatMap((c) => {
    const why = caseSkipReason(c);
    return why === undefined ? [] : [`  skip ${c.id}: ${why}`];
  });
  const estimate = estimateRunCost(cases, profile, trials);
  console.log(
    `evals: ${mode} / ${suite} / ${profile.name} (${profile.modelId}): ${cases.length} case(s), ${cases.length - skips.length} runnable, ${trials} trial(s) each. Estimated cost ≈ $${estimate.toFixed(4)} (budget guard $${maxCostUsd}).`,
  );
  for (const line of skips) console.log(line);
  if (args.dryRun) return;

  const llm = rateLimited(new ConverseLlmClient({ maxAttempts: 1 }), {
    onRetry: ({ modelId, attempt, delayMs, error }) =>
      console.log(`  retry ${attempt} on ${modelId} in ${delayMs} ms (${errorReason(error)})`),
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
        }${t.reason ? `  (${t.reason})` : ""}`,
      ),
  });
  report.rateLimit = { ...llm.stats };

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
