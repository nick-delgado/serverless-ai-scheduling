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
 * Scenario runs are judged by the LLM judge (#32) on `--judge-profile` (default `JUDGE_MODEL_PROFILE`,
 * else `haiku-4.5`), through the same client; `--no-judge` turns it off. Its scores are reported beside
 * each trial's status and never change it; its cost is reported apart and counts toward `--max-cost`.
 * Calibration: `--export-calibration <results.json>` writes transcripts and an empty labels file to
 * `--calibration-dir` (default `packages/evals/calibration`); `--calibrate` judges the labelled ones and
 * reports judge–human agreement. The calibration steps ignore the run flags (`--mode`, `--suite`,
 * `--filter`, `--trials`, `--replay`, and `--max-cost`: no budget stop). `--calibrate` honours `--dry-run`
 * (it prints only its estimate) and writes its report to `--out`; it prints its estimate before calling
 * the judge. The export ignores `--dry-run`.
 *
 * Other flags: `--filter <substring>[,<substring>…]`, `--max-cost <usd>` (default 1), `--dry-run`
 * (list cases and the estimate, no calls), `--out <dir>`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConverseLlmClient } from "@sched/agent";

import {
  calibrationStep,
  caseSkipReason,
  estimateRunCost,
  exitCodeFor,
  fileCalibrationDeps,
  judgeSetup,
  orUsageError,
  orUsageErrorAsync,
  parseCliArgs,
  resultsBasePath,
  runOptions,
  selectCases,
  simulatorSetup,
} from "./cli-args";
import { loadScenarios } from "./loader";
import { errorReason } from "./util";
import { rateLimited } from "./rate-limit";
import { failedChecks, markdownSummary, runSuite } from "./suite";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

/* v8 ignore start -- the process entry point: main() runs only as a script under tsx, never in tests. Its steps are cli-args.ts's tested functions (setup, options, the calibration step and files, usage errors); what stays here is untested wiring: the client, the calibration-or-run dispatch, the replay file read, the estimate line's wording (judge included), the progress lines, and the results writes. */
function fail(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = orUsageError(() => parseCliArgs(process.argv.slice(2), RESULTS_DIR), fail);
  const { mode, suite, trials, maxCostUsd, profile } = args;
  const loaded = loadScenarios();

  // One rate-limited client for the agent, the simulator and the judge: one quota per model ID (#31, #32).
  const llm = rateLimited(new ConverseLlmClient({ maxAttempts: 1 }), {
    onRetry: ({ modelId, attempt, delayMs, error }) =>
      console.log(`  retry ${attempt} on ${modelId} in ${delayMs} ms (${errorReason(error)})`),
  });
  const judging = orUsageError(() => judgeSetup(args, { llm }), fail);
  if (args.calibration !== undefined) {
    // Bound here: the narrowing of `args.calibration` doesn't reach into the callback.
    const step = { ...args, calibration: args.calibration };
    const deps = fileCalibrationDeps(loaded.scenarios, console.log);
    await orUsageErrorAsync(() => calibrationStep(step, judging, deps), fail);
    return;
  }

  const cases = selectCases(loaded, args);
  if (cases.length === 0) fail("no cases match");
  const setup = orUsageError(
    () => simulatorSetup(args, { llm, readReplay: (path) => JSON.parse(readFileSync(path, "utf8")) }),
    fail,
  );
  const { simulator } = setup;

  const skips = cases.flatMap((c) => {
    const why = caseSkipReason(c, simulator);
    return why === undefined ? [] : [`  skip ${c.id}: ${why}`];
  });
  const estimate = estimateRunCost(cases, profile, trials, setup, judging);
  console.log(
    `evals: ${mode} / ${suite} / ${profile.name} (${profile.modelId}): ${cases.length} case(s), ${cases.length - skips.length} runnable, ${trials} trial(s) each${simulator === undefined ? "" : `, simulator ${simulator.name}`}${judging.kind === "llm" ? `, judge ${judging.judge.name}` : ""}. Estimated cost ≈ $${estimate.toFixed(4)}${judging.kind === "llm" ? ", judge included" : ""} (budget guard $${maxCostUsd}).`,
  );
  for (const line of skips) console.log(line);
  if (args.dryRun) return;

  const report = await runSuite(
    cases,
    runOptions(args, {
      llm,
      rateLimit: llm,
      setup,
      judging,
      onTrial: (id, t) =>
        console.log(
          `  ${t.status.padEnd(5)} ${id}#${t.trial}  $${t.costUsd.toFixed(5)}  ${t.durationMs} ms  ${failedChecks(t).join("; ")}`,
        ),
    }),
  );

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
/* v8 ignore stop -- end of the entry point */
