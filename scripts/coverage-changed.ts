/**
 * Changed-line coverage gate (#140): fails when a line this branch adds is never executed by a test.
 *
 *   npm run test:coverage && npm run coverage:changed [-- [--base <ref>] [--coverage <path>]]
 *
 * It reads `coverage/coverage-final.json` (written by `npm run test:coverage`) and the lines added by
 * `git diff -U0 -M <base>...HEAD`, and prints each added line of a covered source file that is
 *   - inside a statement that never ran, or
 *   - the start of a branch arm that never ran (an `if`/`else` arm, a ternary arm, a `switch` case, a
 *     default argument, or the right operand of `??`, `||` or `&&`).
 * Lines inside an arm's range aren't flagged for the arm itself, so an `if` body that ran is never flagged
 * because its implicit `else` didn't. Only committed changes count; the working tree is not read.
 *
 * The base is `--base`, else `COVERAGE_BASE` (CI passes the PR's base SHA; an empty value counts as unset,
 * as on push runs), else `origin/main`. Files outside the coverage `include`/`exclude` in vitest.config.ts
 * (tests, docs, shell scripts, spikes) are ignored.
 *
 * A deliberate exception is a coverage ignore hint in the diff with a reason after `--`:
 * `/* v8 ignore next -- <reason> *\/` (or `start`/`stop`; Vitest 5 honours it without `@preserve`, which
 * doesn't count as a reason). An added source line that holds a hint with no reason fails too (r1/Q-1),
 * so every exception says why. That check runs on every added line of a source file, including one the
 * coverage JSON leaves out (an `ignore file` hint drops its file from the JSON).
 * Coverage shows that a line ran, not that a test checks it: breaking each thing the code does
 * (CLAUDE.md, definition of done) still applies.
 *
 * Exit codes: 0 pass; 1 uncovered added lines or unexplained hints; 2 the gate couldn't run (no coverage
 * JSON, or no merge base with the base ref in CI; locally a missing merge base only warns and passes).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";
import { parseArgs } from "node:util";

import { COVERAGE_EXCLUDE, COVERAGE_INCLUDE } from "../vitest.config";

export const DEFAULT_BASE = "origin/main";
export const DEFAULT_COVERAGE_FILE = "coverage/coverage-final.json";
/**
 * Output limit for the git commands. `execFileSync`'s default is 1 MB, and a branch whose `git diff` is longer
 * (generated files, committed results) made the gate crash with ENOBUFS instead of checking it (#113).
 */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

interface Range {
  start: { line: number };
  end: { line: number };
}

/**
 * The parts of an istanbul file-coverage entry (what coverage-final.json holds per file) the gate reads.
 * A branch arm with no source location (the implicit `else` of an `if`) has an empty `start`.
 */
export interface FileCoverage {
  statementMap: Record<string, Range>;
  s: Record<string, number>;
  branchMap: Record<string, { locations: { start: { line?: number } }[] }>;
  b: Record<string, number[]>;
}

export interface AddedLine {
  line: number;
  text: string;
}

export interface Finding {
  file: string;
  line: number;
}

/** Added lines per file (new path, repo-relative) from `git diff -U0` output. Deleted files have none. */
export function parseAddedLines(diff: string): Map<string, AddedLine[]> {
  const added = new Map<string, AddedLine[]>();
  let lines: AddedLine[] | undefined;
  let inHeader = false;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHeader = true;
      lines = undefined;
    } else if (inHeader && raw.startsWith("+++ b/")) {
      lines = [];
      added.set(raw.slice("+++ b/".length), lines);
    } else if (raw.startsWith("@@ ")) {
      inHeader = false;
      next = Number(/^@@ -\S+ \+(\d+)/.exec(raw)?.[1]);
    } else if (lines && raw.startsWith("+")) {
      lines.push({ line: next, text: raw.slice(1) });
      next += 1;
    }
  }
  return added;
}

/**
 * Line numbers a test never reached: every line of a statement that never ran, and the start line of each
 * branch arm that never ran. An arm without a location (an `if` with no `else`) has no line to flag.
 */
export function uncoveredLines(coverage: FileCoverage): Set<number> {
  const lines = new Set<number>();
  for (const [id, { start, end }] of Object.entries(coverage.statementMap)) {
    if (coverage.s[id] !== 0) continue;
    for (let line = start.line; line <= end.line; line += 1) lines.add(line);
  }
  for (const [id, branch] of Object.entries(coverage.branchMap)) {
    branch.locations.forEach((arm, i) => {
      if (coverage.b[id]?.[i] === 0 && arm.start.line !== undefined) lines.add(arm.start.line);
    });
  }
  return lines;
}

/**
 * The hints Vitest's v8 provider honours, mirroring `ast-v8-to-istanbul` 1.0.7 (`src/ignore-hints.ts`):
 * `if`/`else`/`next`/`file` at the start of a `//`, `/*` or `/**` comment (or at the start of a line, as on the
 * line after a `/*` opener: the provider's `p`), and `start`/`stop` anywhere on a source line, with no comment
 * opener needed. The provider reads comments with a tokenizer; this reads one line at a time.
 */
const HINTS = [
  /(?:\/\/|\/\*\*?)\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file)(?=\W|$)/,
  /^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file)(?=\W|$)/,
  /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:start|stop)(?=\W|$)/,
];

/** True when the line holds a coverage ignore hint whose comment gives no reason after `--`. */
export function hintWithoutReason(text: string): boolean {
  return HINTS.some((pattern) => {
    const hint = pattern.exec(text);
    if (!hint) return false;
    const rest = text.slice(hint.index + hint[0].length);
    const close = rest.indexOf("*/");
    const comment = close < 0 ? rest : rest.slice(0, close);
    const dashes = comment.indexOf("--");
    if (dashes < 0) return true;
    return (
      comment
        .slice(dashes + 2)
        .replace("@preserve", "")
        .trim() === ""
    );
  });
}

/** Which repo-relative paths are source files: the coverage `include`/`exclude` globs. */
export interface SourceGlobs {
  include: readonly string[];
  exclude: readonly string[];
}

export const SOURCE_GLOBS: SourceGlobs = { include: COVERAGE_INCLUDE, exclude: COVERAGE_EXCLUDE };

export function isSourceFile(file: string, globs: SourceGlobs): boolean {
  return (
    globs.include.some((glob) => matchesGlob(file, glob)) &&
    !globs.exclude.some((glob) => matchesGlob(file, glob))
  );
}

/**
 * Uncovered added lines, for added files present in `coverage`, and added hints without a reason, for added
 * source files (`globs`), whether or not `coverage` holds them.
 */
export function checkChanged(
  added: Map<string, AddedLine[]>,
  coverage: Map<string, FileCoverage>,
  globs: SourceGlobs,
): { uncovered: Finding[]; unexplained: Finding[] } {
  const uncovered: Finding[] = [];
  const unexplained: Finding[] = [];
  for (const [file, lines] of added) {
    const fileCoverage = coverage.get(file);
    const missed = fileCoverage ? uncoveredLines(fileCoverage) : new Set<number>();
    const source = isSourceFile(file, globs);
    for (const { line, text } of lines) {
      if (missed.has(line)) uncovered.push({ file, line });
      if (source && hintWithoutReason(text)) unexplained.push({ file, line });
    }
  }
  return { uncovered, unexplained };
}

/** Coverage keyed by repo-relative path (POSIX: CI runs on Linux); files outside `root` are dropped. */
export function coverageByFile(json: Record<string, FileCoverage>, root: string): Map<string, FileCoverage> {
  const byFile = new Map<string, FileCoverage>();
  for (const [path, fileCoverage] of Object.entries(json)) {
    const rel = relative(root, path);
    if (!rel.startsWith("..")) byFile.set(rel, fileCoverage);
  }
  return byFile;
}

export interface CliArgs {
  base?: string;
  coverage?: string;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { base: { type: "string" }, coverage: { type: "string" } },
      strict: true,
    });
    return { base: values.base, coverage: values.coverage };
  } catch (err) {
    throw new Error(
      `usage: coverage-changed [--base <ref>] [--coverage <path>] (${(err as Error).message})`,
      {
        cause: err,
      },
    );
  }
}

/**
 * What a script's `main` takes besides its options (shared with pr-evidence.ts and dup-changed.ts, #184,
 * journal-links.ts, #194, and eval-gate.ts, #34).
 */
export interface ScriptDeps {
  /** Directory git runs in; defaults to the process's working directory. */
  cwd?: string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

export interface CliDeps extends ScriptDeps {
  /** Which files are source; defaults to the coverage globs in vitest.config.ts. */
  sources?: SourceGlobs;
}

export type Git = (...args: string[]) => string;

/** The deps' loggers (the console by default), and a git runner in `deps.cwd`. */
export function scriptIo(deps: ScriptDeps): {
  log: (line: string) => void;
  logError: (line: string) => void;
  git: Git;
} {
  return {
    log: deps.log ?? ((line: string) => console.log(line)),
    logError: deps.logError ?? ((line: string) => console.error(line)),
    git: (...args: string[]) =>
      execFileSync("git", args, { cwd: deps.cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER }),
  };
}

/**
 * Undefined when `base` has a merge base with HEAD. Otherwise the exit code, after saying why: 2 in CI, which must
 * fetch the full history, and 0 locally, where the check skips.
 */
export function noMergeBase(
  script: string,
  base: string,
  git: Git,
  vars: Record<string, string | undefined>,
  logError: (line: string) => void,
): number | undefined {
  try {
    git("merge-base", base, "HEAD");
    return undefined;
  } catch {
    if (vars.CI) {
      logError(`${script}: no merge base with ${base} (CI must fetch the full history).`);
      return 2;
    }
    logError(`${script}: SKIPPING: no merge base with ${base} (fetch it, or pass --base <ref>).`);
    return 0;
  }
}

/** The lines added since `base`, by `git diff -U0 -M <base>...HEAD`, whatever the user's diff config. */
export const addedSince = (git: Git, base: string): Map<string, AddedLine[]> =>
  parseAddedLines(
    git("-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", `${base}...HEAD`),
  );

/**
 * The ref a script diffs against: its `--base` value, else `env` (the script's environment variable, such as
 * `PR_BASE`) when it's non-empty, else `DEFAULT_BASE`. An empty value counts as unset, as CI passes one on push runs.
 * pr-evidence.ts, journal-links.ts and eval-gate.ts share it (#199, #34).
 */
export const baseRef = (flag: string | undefined, env: string | undefined): string =>
  flag ?? (env || DEFAULT_BASE);

/**
 * The names `git diff --name-only <filter> <base>...HEAD -- <paths>` lists, non-ASCII ones unquoted, empty lines
 * dropped: the files changed since the merge base, as `filter` (one `git diff` option: a `--diff-filter=` flag, or
 * `--no-renames` in eval-gate.ts, which lists a renamed file under both names) selects, limited to `paths`
 * (none: every path). Git limits rename detection to `paths` too. It throws when git fails (no merge base, unknown
 * ref); each caller says why and exits. pr-evidence.ts, journal-links.ts and eval-gate.ts share it (#199, #34).
 */
export const namesSince = (git: Git, base: string, filter: string, paths: readonly string[] = []): string[] =>
  git("-c", "core.quotePath=false", "diff", "--name-only", filter, `${base}...HEAD`, "--", ...paths)
    .split("\n")
    .filter((name) => name !== "");

/** The script's entry point; returns the exit code (see the header). `vars` is the process environment. */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: CliDeps = {},
): number {
  const { log, logError, git } = scriptIo(deps);
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    logError((err as Error).message);
    return 2;
  }
  const root = git("rev-parse", "--show-toplevel").trim();
  const base = args.base ?? (vars.COVERAGE_BASE || DEFAULT_BASE);
  const coverageFile = join(root, args.coverage ?? DEFAULT_COVERAGE_FILE);

  if (!existsSync(coverageFile)) {
    logError(`coverage-changed: no ${coverageFile}; run \`npm run test:coverage\` first.`);
    return 2;
  }
  const skip = noMergeBase("coverage-changed", base, git, vars, logError);
  if (skip !== undefined) return skip;

  const coverage = coverageByFile(
    JSON.parse(readFileSync(coverageFile, "utf8")) as Record<string, FileCoverage>,
    root,
  );
  const { uncovered, unexplained } = checkChanged(
    addedSince(git, base),
    coverage,
    deps.sources ?? SOURCE_GLOBS,
  );

  if (uncovered.length > 0) {
    log(`Added lines no test executes (${uncovered.length}):`);
    for (const { file, line } of uncovered) log(`${file}:${line}`);
  }
  if (unexplained.length > 0) {
    log(`Coverage ignore hints without a reason after "--" (${unexplained.length}):`);
    for (const { file, line } of unexplained) log(`${file}:${line}`);
  }
  if (uncovered.length + unexplained.length > 0) {
    logError(
      "coverage-changed: give each line above a test, or an ignore hint with a reason " +
        "(`/* v8 ignore next -- <reason> */`). Coverage shows a line ran, not that a test checks it.",
    );
    return 1;
  }
  log(`coverage-changed: every added source line since ${base} ran in a test.`);
  return 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
