/**
 * Duplicate-code check on changed lines (#184, B6-6; promotes B5-6): fails when a clone that jscpd finds has a side
 * in lines this branch adds.
 *
 *   npm run dup:changed [-- [--base <ref>] [--config <path>]]
 *
 * It runs jscpd over the repository with `.jscpd.json` (or `--config`), which holds the thresholds, the formats and
 * the ignore globs, reads the lines added by `git diff -U0 -M <base>...HEAD` (the coverage gate's parser), and prints
 * each clone whose first or second side overlaps an added line of its file, with the other side, so the copy can be
 * shared instead (`.claude/skills/task-workflow/SKILL.md`, step 5). A clone wholly in lines the branch didn't add is
 * old duplication and passes. jscpd reads the working tree; the diff counts only committed changes.
 *
 * A deliberate copy is fenced with `// jscpd:ignore-start` and `// jscpd:ignore-end` comments, with the reason beside
 * them.
 *
 * The base is `--base`, else `DUP_BASE` (CI passes the PR's base SHA; an empty value counts as unset, as on push
 * runs), else `origin/main`.
 *
 * Exit codes: 0 no clone touches an added line; 1 one does; 2 the check couldn't run (bad arguments, jscpd failed, or
 * no merge base with the base in CI; locally a missing merge base only warns and passes).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  type AddedLine,
  addedSince,
  DEFAULT_BASE,
  GIT_MAX_BUFFER,
  noMergeBase,
  type ScriptDeps,
  scriptIo,
} from "./coverage-changed";

export const DEFAULT_CONFIG = ".jscpd.json";

/** One side of a clone in jscpd's JSON report: the file, relative to the scanned directory, and its first and last line. */
export interface Side {
  name: string;
  start: number;
  end: number;
}

export interface Clone {
  firstFile: Side;
  secondFile: Side;
  lines: number;
  tokens: number;
}

/** True when the side's line range holds a line added to its file. */
export function touchesAdded(side: Side, added: ReadonlyMap<string, readonly AddedLine[]>): boolean {
  return (added.get(side.name) ?? []).some(({ line }) => line >= side.start && line <= side.end);
}

/** The clones with at least one side in added lines, in the report's order. */
export function changedClones(
  clones: readonly Clone[],
  added: ReadonlyMap<string, readonly AddedLine[]>,
): Clone[] {
  return clones.filter(
    (clone) => touchesAdded(clone.firstFile, added) || touchesAdded(clone.secondFile, added),
  );
}

/** One printed line per clone: the side with added lines first. */
export function formatClone(clone: Clone, added: ReadonlyMap<string, readonly AddedLine[]>): string {
  const [ours, theirs] = touchesAdded(clone.firstFile, added)
    ? [clone.firstFile, clone.secondFile]
    : [clone.secondFile, clone.firstFile];
  const at = (side: Side) => `${side.name}:${side.start}-${side.end}`;
  return `${at(ours)} copies ${at(theirs)} (${clone.lines} lines, ${clone.tokens} tokens)`;
}

/** The jscpd launcher, resolved from this script's own dependencies so the check can scan another checkout. */
const JSCPD = createRequire(import.meta.url).resolve("jscpd/run-jscpd.js");

/** Runs jscpd over `cwd` with the config, and returns its clones; throws with jscpd's output when it fails. */
export function runJscpd(config: string, cwd: string): Clone[] {
  const out = mkdtempSync(join(tmpdir(), "dup-changed-"));
  try {
    const run = spawnSync(
      process.execPath,
      [JSCPD, "--config", config, "--reporters", "json", "--output", out, "."],
      { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER },
    );
    if (run.status !== 0) throw new Error(`jscpd exited ${String(run.status)}: ${run.stderr}${run.stdout}`);
    return (JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")) as { duplicates: Clone[] })
      .duplicates;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export interface CliDeps extends ScriptDeps {
  /** Finds the clones; defaults to `runJscpd`. */
  detect?: (config: string, cwd: string) => Clone[];
}

/** The script's entry point; returns the exit code (see the header). `vars` is the process environment. */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: CliDeps = {},
): number {
  // jscpd scans the directory git runs in.
  const cwd = deps.cwd ?? process.cwd();
  const { log, logError, git } = scriptIo({ ...deps, cwd });
  let values: { base?: string | undefined; config?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { base: { type: "string" }, config: { type: "string" } },
      strict: true,
    }));
  } catch (err) {
    logError(`usage: dup-changed [--base <ref>] [--config <path>] (${(err as Error).message})`);
    return 2;
  }
  const base = values.base ?? (vars.DUP_BASE || DEFAULT_BASE);
  const skip = noMergeBase("dup-changed", base, git, vars, logError);
  if (skip !== undefined) return skip;
  const added = addedSince(git, base);
  let clones: Clone[];
  try {
    clones = (deps.detect ?? runJscpd)(resolve(cwd, values.config ?? DEFAULT_CONFIG), cwd);
  } catch (err) {
    logError(`dup-changed: ${(err as Error).message}`);
    return 2;
  }
  const found = changedClones(clones, added);
  if (found.length > 0) {
    log(`Clones with a side in lines added since ${base} (${found.length}):`);
    for (const clone of found) log(formatClone(clone, added));
    logError(
      "dup-changed: share each copy (an export or a helper; task-workflow step 5), or fence a deliberate one with " +
        "`// jscpd:ignore-start` / `// jscpd:ignore-end` and say why.",
    );
    return 1;
  }
  log(
    `dup-changed: no clone touches a line added since ${base} (${clones.length} clones in the repository).`,
  );
  return 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
