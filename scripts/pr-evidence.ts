/**
 * Seen-failing evidence check for a PR (#184, B6-5; decides B5-5). It fails when the PR changes a source file and
 * its body has no `npm run mutate -- … --markdown` table with a KILLED row for that file.
 *
 *   tsx scripts/pr-evidence.ts [--base <ref>]      (the PR body comes from PR_BODY)
 *
 * Source files are the coverage gate's (`SOURCE_GLOBS`: `packages/*\/src`, `services/*\/src`, `apps/*\/src` and
 * `scripts/*.ts`, without tests and `.d.ts` files; spikes are outside them), less `test/` directories inside them
 * (`EVIDENCE_GLOBS`), added, changed or renamed in `git diff <base>...HEAD`. Deleted files need no evidence. A table is
 * found by `MARKDOWN_HEADER`, and every table in the body counts; a row names its File cell exactly, as
 * `npm run mutate` prints it from the repo root. Only a KILLED row counts (`KILLED`, or `KILLED (no expect)` for an
 * edit with no `expect` list), so a file whose rows are all SURVIVED, KILLED-OTHER, TIMEOUT, ERROR or REFUSED fails
 * (Nick's decision 545feee/SPEC-6 (b) on PR #185). Docs-only and test-only PRs pass. The base is `--base`, else
 * `PR_BASE` (the workflow passes the PR's base SHA), else `origin/main`.
 *
 * Exit codes: 0 every changed source file has a KILLED row; 1 one hasn't; 2 the check couldn't run (bad arguments, no
 * merge base with the base).
 */
import { parseArgs } from "node:util";

import {
  baseRef,
  isSourceFile,
  namesSince,
  type ScriptDeps,
  scriptIo,
  SOURCE_GLOBS,
  type SourceGlobs,
} from "./coverage-changed";
import { MARKDOWN_HEADER } from "./mutate";

/** The source files the evidence check covers: the coverage gate's, less `test/` directories inside a `src` tree. */
export const EVIDENCE_GLOBS: SourceGlobs = {
  ...SOURCE_GLOBS,
  exclude: [...SOURCE_GLOBS.exclude, "**/test/**"],
};

/** A Status cell that counts as evidence: `KILLED`, or `KILLED (no expect)` (see `markdownTable`). */
const KILLED_CELL = /^KILLED( \(no expect\))?$/;

/** The files in the File column of a KILLED row of every mutate `--markdown` table in `body`. */
export function killedFiles(body: string): Set<string> {
  const named = new Set<string>();
  let inTable = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === MARKDOWN_HEADER) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    // Cells split on pipes that aren't escaped; the File cell is the second, the Status cell the fourth.
    const cells = line.split(/(?<!\\)\|/);
    const path = cells[2]?.trim().replace(/^(`+) ?(.*?) ?\1$/, "$2");
    if (path && KILLED_CELL.test(cells[4]?.trim() ?? "")) named.add(path);
  }
  return named;
}

/** Source files among `changed` that no KILLED row in `body` names, in `changed`'s order. */
export function missingEvidence(changed: readonly string[], body: string, globs: SourceGlobs): string[] {
  const named = killedFiles(body);
  return changed.filter((file) => isSourceFile(file, globs) && !named.has(file));
}

/** The script's entry point; returns the exit code (see the header). `vars` is the process environment. */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: ScriptDeps = {},
): number {
  const { log, logError, git } = scriptIo(deps);
  let base: string;
  try {
    const { values } = parseArgs({ args: [...argv], options: { base: { type: "string" } }, strict: true });
    base = baseRef(values.base, vars.PR_BASE);
  } catch (err) {
    logError(`usage: pr-evidence [--base <ref>] (${(err as Error).message})`);
    return 2;
  }
  let changed: string[];
  try {
    changed = namesSince(git, base, "--diff-filter=d");
  } catch (err) {
    logError(`pr-evidence: can't diff against ${base} (fetch the full history): ${(err as Error).message}`);
    return 2;
  }
  const missing = missingEvidence(changed, vars.PR_BODY ?? "", EVIDENCE_GLOBS);
  if (missing.length > 0) {
    log(`Changed source files with no KILLED row in a mutate table in the PR body (${missing.length}):`);
    for (const file of missing) log(file);
    logError(
      "pr-evidence: paste `npm run --silent mutate -- <edits.json> --markdown -- <test command>` output covering " +
        "every changed source file, with a KILLED row for each, into the PR body (CLAUDE.md, definition of done).",
    );
    return 1;
  }
  log(`pr-evidence: every changed source file since ${base} has a KILLED row in a mutate table.`);
  return 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
