/**
 * Seen-failing evidence check for a PR (#184, B6-5; decides B5-5). It fails when the PR changes a source file and
 * its body has no `npm run mutate -- … --markdown` table naming that file.
 *
 *   tsx scripts/pr-evidence.ts [--base <ref>]      (the PR body comes from PR_BODY)
 *
 * Source files are the coverage gate's (`SOURCE_GLOBS`: `packages/*\/src`, `services/*\/src`, `apps/*\/src` and
 * `scripts/*.ts`, without tests and `.d.ts` files; spikes are outside them), added, changed or renamed in
 * `git diff <base>...HEAD`. Deleted files need no evidence. A table is found by `MARKDOWN_HEADER`, and every table in
 * the body counts; a row names its File cell exactly, as `npm run mutate` prints it from the repo root. Docs-only and
 * test-only PRs pass. The base is `--base`, else `PR_BASE` (the workflow passes the PR's base SHA), else `origin/main`.
 *
 * Exit codes: 0 every changed source file is named; 1 one isn't; 2 the check couldn't run (bad arguments, no
 * merge base with the base).
 */
import { parseArgs } from "node:util";

import {
  DEFAULT_BASE,
  isSourceFile,
  type ScriptDeps,
  scriptIo,
  SOURCE_GLOBS,
  type SourceGlobs,
} from "./coverage-changed";
import { MARKDOWN_HEADER } from "./mutate";

/** The files named in the File column of every mutate `--markdown` table in `body`. */
export function namedFiles(body: string): Set<string> {
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
    // Cells split on pipes that aren't escaped; the File cell is the second.
    const file = line.split(/(?<!\\)\|/)[2]?.trim();
    const path = file?.replace(/^(`+) ?(.*?) ?\1$/, "$2");
    if (path && !/^-+$/.test(path)) named.add(path);
  }
  return named;
}

/** Source files among `changed` that `body` names in no table, in `changed`'s order. */
export function missingEvidence(changed: readonly string[], body: string, globs: SourceGlobs): string[] {
  const named = namedFiles(body);
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
    base = values.base ?? (vars.PR_BASE || DEFAULT_BASE);
  } catch (err) {
    logError(`usage: pr-evidence [--base <ref>] (${(err as Error).message})`);
    return 2;
  }
  let changed: string[];
  try {
    changed = git(
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "-M",
      "--diff-filter=d",
      `${base}...HEAD`,
    )
      .split("\n")
      .filter((file) => file !== "");
  } catch (err) {
    logError(`pr-evidence: can't diff against ${base} (fetch the full history): ${(err as Error).message}`);
    return 2;
  }
  const missing = missingEvidence(changed, vars.PR_BODY ?? "", SOURCE_GLOBS);
  if (missing.length > 0) {
    log(`Changed source files no mutate table in the PR body names (${missing.length}):`);
    for (const file of missing) log(file);
    logError(
      "pr-evidence: paste `npm run --silent mutate -- <edits.json> --markdown -- <test command>` output covering " +
        "every changed source file into the PR body (CLAUDE.md, definition of done).",
    );
    return 1;
  }
  log(`pr-evidence: every changed source file since ${base} is in a mutate table.`);
  return 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
