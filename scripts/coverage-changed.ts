/**
 * Changed-line coverage gate (#140): fails when a line this branch adds is never executed by a test.
 *
 *   npm run test:coverage && npm run coverage:changed [-- --base <ref>] [--coverage <path>]
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
 * as on push runs), else `origin/main`. Files missing from the coverage JSON (tests, docs, shell scripts,
 * spikes: anything outside the coverage `include` in vitest.config.ts) are ignored.
 *
 * A deliberate exception is a coverage ignore hint in the diff with a reason after `--`:
 * `/* v8 ignore next -- <reason> *\/` (or `start`/`stop`; Vitest 5 honours it without `@preserve`, which
 * doesn't count as a reason). An added source line that holds a hint with no reason fails too (r1/Q-1),
 * so every exception says why.
 * Coverage shows that a line ran, not that a test checks it: breaking each thing the code does
 * (CLAUDE.md, definition of done) still applies.
 *
 * Exit codes: 0 pass; 1 uncovered added lines or unexplained hints; 2 the gate couldn't run (no coverage
 * JSON, or no merge base with the base ref in CI; locally a missing merge base only warns and passes).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const DEFAULT_BASE = "origin/main";
export const DEFAULT_COVERAGE_FILE = "coverage/coverage-final.json";

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
  branchMap: Record<string, { type: string; locations: { start: { line?: number } }[] }>;
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

const HINT = /(?:\/\/|\/\*)\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file|start|stop)\b/;

/** True when the line holds a coverage ignore hint whose comment gives no reason after `--`. */
export function hintWithoutReason(text: string): boolean {
  const hint = HINT.exec(text);
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
}

/** Uncovered added lines and added hints without a reason, for every added file present in `coverage`. */
export function checkChanged(
  added: Map<string, AddedLine[]>,
  coverage: Map<string, FileCoverage>,
): { uncovered: Finding[]; unexplained: Finding[] } {
  const uncovered: Finding[] = [];
  const unexplained: Finding[] = [];
  for (const [file, lines] of added) {
    const fileCoverage = coverage.get(file);
    if (!fileCoverage) continue;
    const missed = uncoveredLines(fileCoverage);
    for (const { line, text } of lines) {
      if (missed.has(line)) uncovered.push({ file, line });
      if (hintWithoutReason(text)) unexplained.push({ file, line });
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
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--base" && flag !== "--coverage") || value === undefined || value.startsWith("--"))
      throw new Error(`usage: coverage-changed [--base <ref>] [--coverage <path>] (got ${flag})`);
    args[flag === "--base" ? "base" : "coverage"] = value;
    i += 1;
  }
  return args;
}

export interface CliDeps {
  /** Directory git runs in; defaults to the process's working directory. */
  cwd?: string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/** The script's entry point; returns the exit code (see the header). `vars` is the process environment. */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: CliDeps = {},
): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: deps.cwd, encoding: "utf8" });
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
  try {
    git("merge-base", base, "HEAD");
  } catch {
    if (vars.CI) {
      logError(`coverage-changed: no merge base with ${base} (CI must fetch the full history).`);
      return 2;
    }
    logError(`coverage-changed: SKIPPING: no merge base with ${base} (fetch it, or pass --base <ref>).`);
    return 0;
  }

  const diff = git(
    "-c",
    "core.quotePath=false",
    "diff",
    "-U0",
    "-M",
    "--no-color",
    "--no-ext-diff",
    `${base}...HEAD`,
  );
  const coverage = coverageByFile(
    JSON.parse(readFileSync(coverageFile, "utf8")) as Record<string, FileCoverage>,
    root,
  );
  const { uncovered, unexplained } = checkChanged(parseAddedLines(diff), coverage);

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
