// Stryker config for the #113 trial. spikes/stryker/run.ts sets the environment and `--mutate`; see README.md.
//   STRYKER_PACKAGE  the package whose Vitest project runs (required), e.g. packages/tools
//   STRYKER_CHECKER  "on" adds the TypeScript checker (mutants that don't compile become CompileError)
//   STRYKER_LABEL    names the reports in spikes/stryker/results/
//   STRYKER_CONCURRENCY  worker count (default 4)
const pkg = process.env.STRYKER_PACKAGE;
if (!pkg) throw new Error("Set STRYKER_PACKAGE");
const checker = process.env.STRYKER_CHECKER === "on";
const label = process.env.STRYKER_LABEL ?? "run";
const results = process.env.STRYKER_RESULTS ?? "spikes/stryker/results";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner", ...(checker ? ["@stryker-mutator/typescript-checker"] : [])],
  vitest: { configFile: "spikes/stryker/vitest.package.config.ts", related: true },
  checkers: checker ? ["typescript"] : [],
  tsconfigFile: `${pkg}/tsconfig.json`,
  ...(checker ? { typescriptChecker: { prioritizePerformanceOverAccuracy: true } } : {}),
  coverageAnalysis: "perTest",
  concurrency: Number(process.env.STRYKER_CONCURRENCY ?? 4),
  timeoutMS: 10000,
  tempDirName: "spikes/stryker/.stryker-tmp",
  cleanTempDir: true,
  // The sandbox copies the repo. `.claude/skills` holds symlinked folders that Stryker's copy can't follow
  // (ENOTSUP), and none of these folders is read by a package's tests.
  ignorePatterns: [
    ".claude",
    ".agents",
    ".github",
    "docs",
    "infra",
    "coverage",
    "packages/evals/results",
    "spikes/stryker/results",
    ".worktrees",
  ],
  reporters: ["clear-text", "progress", "json", "html"],
  jsonReporter: { fileName: `${results}/${label}.json` },
  htmlReporter: { fileName: `${results}/${label}.html` },
  clearTextReporter: { allowColor: false, logTests: false, maxTestsToLog: 0 },
  incremental: false,
};
