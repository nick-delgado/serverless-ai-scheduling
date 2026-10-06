/**
 * Journal PR-link check (#194, B7-3, from the review of PR #189, STD-2): a journal entry a PR adds names that PR on
 * its `**Related:**` line (`task-workflow` step 7, "add `PR #<number>` to its Related line").
 *
 *   tsx scripts/journal-links.ts [--base <ref>] [--pr <number>]
 *
 * Entries are the `.md` files under `docs/journal/` other than `README.md` that `git diff --diff-filter=A
 * <base>...HEAD` adds (one git pairs with a deleted file as a rename isn't added); each is read at HEAD. One whose
 * Related line doesn't contain `PR #<number>` (not as the start of a longer number), or that has no Related line,
 * fails. A PR that adds no entry passes. The PR number is `--pr`, else
 * `PR_NUMBER`; the base is `--base`, else `PR_BASE` (the workflow passes the PR's base SHA), else `origin/main`. A PR's
 * first push is red until its "link PR #N" commit, since the number exists only once the PR does.
 *
 * Exit codes: 0 every added entry links the PR; 1 one doesn't; 2 the check couldn't run (bad arguments, no PR number,
 * no merge base with the base).
 */
import { parseArgs } from "node:util";

import { DEFAULT_BASE, type ScriptDeps, scriptIo } from "./coverage-changed";

/** The value of an entry's `**<name>:**` line (Chapter, Milestone, Related), trimmed; none when it's missing or empty. */
export const field = (text: string, name: string): string | undefined =>
  new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.+?)\\s*$`, "m").exec(text)?.[1];

/** The value of an entry's `**Related:**` line, if it has one. */
export const relatedLine = (text: string): string | undefined => field(text, "Related");

/** True when `text` has a Related line naming `PR #<pr>`, and not only a longer number that starts with it. */
export function linksPr(text: string, pr: string): boolean {
  return new RegExp(`(?<![\\w#])PR #${pr}(?!\\d)`).test(relatedLine(text) ?? "");
}

/** True for a journal entry: a `.md` file under `docs/journal/`, not the index. */
export const isEntry = (file: string): boolean =>
  file.startsWith("docs/journal/") && file.endsWith(".md") && file !== "docs/journal/README.md";

/** The script's entry point; returns the exit code (see the header). `vars` is the process environment. */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: ScriptDeps = {},
): number {
  const { log, logError, git } = scriptIo(deps);
  let base: string;
  let pr: string;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { base: { type: "string" }, pr: { type: "string" } },
      strict: true,
    });
    base = values.base ?? (vars.PR_BASE || DEFAULT_BASE);
    pr = values.pr ?? vars.PR_NUMBER ?? "";
    if (!/^[1-9]\d*$/.test(pr)) throw new Error(`no PR number (got "${pr}"; pass --pr or set PR_NUMBER)`);
  } catch (err) {
    logError(`usage: journal-links [--base <ref>] [--pr <number>] (${(err as Error).message})`);
    return 2;
  }
  let added: string[];
  try {
    added = git(
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "--diff-filter=A",
      `${base}...HEAD`,
      "--",
      "docs/journal/",
    )
      .split("\n")
      .filter(isEntry);
  } catch (err) {
    logError(`journal-links: can't diff against ${base} (fetch the full history): ${(err as Error).message}`);
    return 2;
  }
  const unlinked = added.filter((file) => !linksPr(git("show", `HEAD:${file}`), pr));
  if (unlinked.length > 0) {
    log(`Journal entries this PR adds whose Related line doesn't name PR #${pr} (${unlinked.length}):`);
    for (const file of unlinked) log(file);
    logError(
      `journal-links: add \`PR #${pr}\` to each entry's **Related:** line, then commit and push ` +
        "(task-workflow step 7).",
    );
    return 1;
  }
  log(`journal-links: every journal entry added since ${base} names PR #${pr} (${added.length} added).`);
  return 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
