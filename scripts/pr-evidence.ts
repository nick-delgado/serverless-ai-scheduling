/**
 * Seen-failing evidence check for a PR (#184, B6-5; decides B5-5). It fails when the PR changes a source file and
 * its body has no `npm run mutate -- … --markdown` table with a KILLED row for that file.
 *
 *   tsx scripts/pr-evidence.ts [--base <ref>]      (the PR body comes from PR_BODY)
 *
 * Source files are the coverage gate's (`SOURCE_GLOBS`: `packages/*\/src`, `services/*\/src`, `apps/*\/src`,
 * `scripts/*.ts`, `scripts/test/*.ts` and `apps/*\/e2e`, without tests, `.d.ts` files and the Playwright specs; spikes
 * are outside them), less helpers in a `src/test/` directory (`EVIDENCE_GLOBS`, #184; `scripts/test/` and
 * `apps/*\/e2e/` helpers need rows since #265, B10-3), added, changed or renamed in `git diff <base>...HEAD`. Deleted
 * files need no evidence. A table is found by `MARKDOWN_HEADER`, and every table in the body counts; a row names its
 * File cell exactly, as `npm run mutate` prints it from the repo root. Only a KILLED row counts (`KILLED`, or `KILLED
 * (no expect)` for an edit with no `expect` list), so a file whose rows are all SURVIVED, KILLED-OTHER, TIMEOUT, ERROR
 * or REFUSED fails (Nick's decision 545feee/SPEC-6 (b) on PR #185). Docs-only and test-only PRs pass. The base is
 * `--base`, else `PR_BASE` (the workflow passes the PR's base SHA), else `origin/main`.
 *
 * A KILLED row counts only while it is current (#265, B10-5, from the review of PR #262, SPEC-2): its `find`, the
 * Change cell's first code span read back as `scripts/mutate.ts`'s `codeSpan` wrote it (the fence and its pad space
 * removed, `\|` read as `|` and `⏎` as a newline; r1/A-2), still occurs in its file at HEAD (`git show HEAD:<file>`;
 * a file missing there makes its rows stale; r1/A-3). Every run prints each stale KILLED row (edit ID, file), for any
 * file, and a file whose only KILLED rows are stale has no evidence. A `find` that itself holds a `⏎` reads back as
 * a newline, so its row is judged stale.
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
import { MARKDOWN_HEADER, occurrences } from "./mutate";

/**
 * The source files the evidence check covers: the coverage gate's, less helpers in a `src/test/` directory
 * (`apps/web/src/test/setup.ts`, #184). Helpers in `scripts/test/` and `apps/*\/e2e/` need rows (#265, B10-3).
 */
export const EVIDENCE_GLOBS: SourceGlobs = {
  ...SOURCE_GLOBS,
  exclude: [...SOURCE_GLOBS.exclude, "**/src/test/**"],
};

/** A Status cell that counts as evidence: `KILLED`, or `KILLED (no expect)` (see `markdownTable`). */
const KILLED_CELL = /^KILLED( \(no expect\))?$/;

/** A KILLED row of a mutate `--markdown` table: its edit ID, File cell and `find`, read back as they were written. */
export interface KilledRow {
  id: string;
  file: string;
  find: string;
}

/** A cell's text as `scripts/mutate.ts`'s `cell` wrote it, read back: `\|` as `|`, then `⏎` as a newline. */
export const uncell = (text: string): string => text.replaceAll("\\|", "|").replaceAll("⏎", "\n");

/**
 * The text of the first code span at the start of `text`, as `codeSpan` wrote it: inside its backtick fence, with
 * the pad space removed when what it pads starts or ends with a backtick, and read back by `uncell`. Undefined when
 * `text` doesn't start with a closed code span.
 */
export function unspan(text: string): string | undefined {
  const span = /^(`+)(.*?)\1(?!`)/.exec(text);
  if (!span) return undefined;
  // The pattern's second group always takes part in a match, if only as "".
  const inner = span[2] as string;
  const padded = /^ (.*) $/.exec(inner)?.[1];
  return uncell(padded !== undefined && /^`|`$/.test(padded) ? padded : inner);
}

/** Every KILLED row of every mutate `--markdown` table in `body`, in order. */
export function killedRows(body: string): KilledRow[] {
  const rows: KilledRow[] = [];
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
    // Cells split on pipes that aren't escaped: the Edit cell is the first, File the second, Change the third,
    // Status the fourth.
    const cells = line.split(/(?<!\\)\|/);
    const cell = (i: number) => cells[i]?.trim() ?? "";
    const file = unspan(cell(2));
    if (file && KILLED_CELL.test(cell(4)))
      rows.push({ id: uncell(cell(1)), file, find: unspan(cell(3)) ?? "" });
  }
  return rows;
}

/** The files in the File column of a KILLED row of every mutate `--markdown` table in `body`. */
export const killedFiles = (body: string): Set<string> => new Set(killedRows(body).map((row) => row.file));

/**
 * Whether each row is current: its `find` occurs in its file's text, which `read` gives (undefined for a file
 * missing at HEAD). Each file is read once.
 */
export function currentRow(read: (file: string) => string | undefined): (row: KilledRow) => boolean {
  const texts = new Map<string, string | undefined>();
  return (row) => {
    if (!texts.has(row.file)) texts.set(row.file, read(row.file));
    const text = texts.get(row.file);
    return text !== undefined && occurrences(text, row.find) >= 1;
  };
}

/** Source files among `changed` that no current KILLED row in `body` names, in `changed`'s order. */
export function missingEvidence(
  changed: readonly string[],
  body: string,
  globs: SourceGlobs,
  current: (row: KilledRow) => boolean = () => true,
): string[] {
  const named = new Set(
    killedRows(body)
      .filter(current)
      .map((row) => row.file),
  );
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
  const body = vars.PR_BODY ?? "";
  const current = currentRow((file) => {
    try {
      return git("show", `HEAD:${file}`);
    } catch {
      return undefined;
    }
  });
  const stale = killedRows(body).filter((row) => !current(row));
  if (stale.length > 0) {
    log(`KILLED rows whose find no longer occurs in their file at HEAD, not counted (${stale.length}):`);
    for (const row of stale) log(`${row.id} ${row.file}`);
  }
  const missing = missingEvidence(changed, body, EVIDENCE_GLOBS, current);
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
