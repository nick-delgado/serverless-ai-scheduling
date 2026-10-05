/**
 * Runs Stryker on one package's changed source files (#113 trial, AC 1; readiness review A-2).
 *
 *   npx tsx spikes/stryker/run.ts --package packages/tools [--base origin/main] [--files <glob,...>]
 *                                 [--checker on|off] [--label <name>] [--concurrency <n>] [--dry]
 *
 * Without `--files`, the files are `git diff --name-only <base>...HEAD`, limited to `<package>/src` and to source
 * files by the coverage gate's own rule (`isSourceFile` with `SOURCE_GLOBS`, from scripts/coverage-changed.ts). `--files` overrides that
 * with an explicit list (globs allowed, as Stryker's `--mutate` takes them). Only that package's Vitest project
 * runs (spikes/stryker/vitest.package.config.ts). Reports go to spikes/stryker/results/<label>.{json,html}.
 * `--dry` prints the file list and the command without running Stryker.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { isSourceFile, SOURCE_GLOBS } from "../../scripts/coverage-changed";

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    base: { type: "string", default: "origin/main" },
    files: { type: "string" },
    checker: { type: "string", default: "off" },
    label: { type: "string" },
    concurrency: { type: "string", default: "4" },
    dry: { type: "boolean", default: false },
  },
});

const pkg = values.package?.replace(/\/$/, "");
if (!pkg) throw new Error("--package is required, e.g. --package packages/tools");

const files = values.files
  ? values.files.split(",")
  : execFileSync("git", ["diff", "--name-only", `${values.base}...HEAD`, "--", `${pkg}/src`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((file) => file !== "" && isSourceFile(file, SOURCE_GLOBS));

if (files.length === 0) {
  console.log(`No changed source files under ${pkg}/src against ${values.base}; nothing to mutate.`);
  process.exit(0);
}

const label =
  values.label ?? `${pkg.replace(/\//g, "-")}-${values.checker === "on" ? "checker" : "nochecker"}`;
const args = ["stryker", "run", "spikes/stryker/stryker.config.mjs", "--mutate", files.join(",")];
console.log(`Mutating ${files.length} file(s) in ${pkg}:\n  ${files.join("\n  ")}\n$ npx ${args.join(" ")}`);
if (values.dry) process.exit(0);

const started = Date.now();
const result = spawnSync("npx", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    STRYKER_PACKAGE: pkg,
    STRYKER_CHECKER: values.checker,
    STRYKER_LABEL: label,
    STRYKER_CONCURRENCY: values.concurrency,
  },
});
console.log(`\nWall time: ${((Date.now() - started) / 1000).toFixed(1)} s (label ${label})`);
process.exit(result.status ?? 1);
