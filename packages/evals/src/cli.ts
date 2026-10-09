/**
 * `npm run evals -- --suite smoke|full --mode l1|scenario --profile <name> --trials <k>`
 *
 * `--mode` defaults to `l1` and stays so (drift-audit decision 7, ADR-008 amendment 2026-10-03); the CI
 * eval gate passes `--mode` explicitly. The full guide is the `run-evals` skill.
 *
 * Live runs call Bedrock (cost real money): every call goes through the shared per-model rate limiter
 * with 429 backoff, a budget guard stops the run at `--max-cost`, and the estimated cost is printed
 * before the first call. Results: `packages/evals/results/<timestamp>-<mode>-<suite>-<profile>.{json,md}`
 * (git-ignored), and a copy outside every checkout (#195), in
 * `$XDG_STATE_HOME/serverless-ai-scheduling/eval-results/<checkout directory name>/` (`~/.local/state/…`
 * when `XDG_STATE_HOME` isn't an absolute path; `EVAL_RESULTS_COPY_DIR` replaces the directory above `<checkout directory name>`;
 * see `results-copy.ts`). The last line prints both `.json` paths; a `--dry-run` writes neither.
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
 * Steps on saved results files, no model calls (#34): `--exit-report <a.json> <b.json>` writes the PRD §7
 * exit table from one L1 and one scenario results file to `--out`; `--update-baseline <a.json> <b.json>`
 * promotes one L1 and one scenario smoke run at k=1 to `packages/evals/baselines/<profile>.json`.
 *
 * Other flags: `--filter <substring>[,<substring>…]`, `--ids <id>[,<id>…]` (exactly these case IDs; the CI
 * gate's re-run of errored cases), `--max-cost <usd>` (default 1), `--dry-run` (list cases and the
 * estimate, no calls), `--out <dir>`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConverseLlmClient } from "@sched/agent";

import {
  calibrationStep,
  caseSkipReason,
  estimateRunCost,
  exitCodeFor,
  exitReportStep,
  fileCalibrationDeps,
  judgeSetup,
  orUsageError,
  orUsageErrorAsync,
  parseCliArgs,
  runOptions,
  selectCases,
  simulatorSetup,
  updateBaselineStep,
} from "./cli-args";
import { loadScenarios } from "./loader";
import { errorReason } from "./util";
import { rateLimited } from "./rate-limit";
import { prepareResultsCopyDir, resultsCopyDir, resultsWrittenLine, writeRunResults } from "./results-copy";
import { failedChecks, markdownSummary, runSuite } from "./suite";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

/* v8 ignore start -- the process entry point: main() runs only as a script under tsx, never in tests. Its steps are cli-args.ts's and results-copy.ts's tested functions (setup, options, the calibration step and files, the exit-report and baseline steps, usage errors, the results copy and its writes); what stays here is untested wiring: the client, the checkout path, the calibration, results-step or run dispatch, the replay file read, the estimate line's wording (judge included), the progress lines, and printing the results line (the copy warning goes through results-copy.ts). */
/** The checkout running the CLI: `packages/evals/src/../../..`. */
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fail(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = orUsageError(() => parseCliArgs(process.argv.slice(2), RESULTS_DIR), fail);
  const { mode, suite, trials, maxCostUsd, profile } = args;
  const loaded = loadScenarios();
  if (args.resultsStep !== undefined) {
    const files = fileCalibrationDeps(loaded.scenarios, console.log);
    const { action, files: paths } = args.resultsStep;
    if (action === "exit") orUsageError(() => exitReportStep({ out: args.out, files: paths }, files), fail);
    else orUsageError(() => updateBaselineStep({ baselineDir: args.baselineDir, files: paths }, files), fail);
    return;
  }

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

  // Checked before any model call, `--dry-run` included (#195, r1/Q-4); created below only for a live run.
  const copyDir = orUsageError(
    () => resultsCopyDir({ env: process.env, home: homedir(), checkout: CHECKOUT }),
    fail,
  );
  const cases = orUsageError(() => selectCases(loaded, args), fail);
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
  orUsageError(() => prepareResultsCopyDir(copyDir, args), fail);
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

  const md = markdownSummary(report);
  const line = resultsWrittenLine(writeRunResults(report, md, { out: args.out, copyDir }), console.error);
  console.log(`\n${md}\n\n${line}`);
  process.exitCode = exitCodeFor(report.summary);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
/* v8 ignore stop -- end of the entry point */
