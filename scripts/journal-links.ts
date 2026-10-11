/**
 * Journal checks (#194, B7-3, from the review of PR #189, STD-2; #240, B9-6): a journal entry a PR adds names that PR
 * on its `**Related:**` line (`task-workflow` step 7, "add `PR #<number>` to its Related line"), and pins each count
 * the PR can still change to a commit or a run.
 *
 *   tsx scripts/journal-links.ts [--base <ref>] [--pr <number>]
 *
 * Entries are the `.md` files under `docs/journal/` other than `README.md` that `git diff --diff-filter=A
 * <base>...HEAD` adds (one git pairs with a deleted file as a rename isn't added); each is read at HEAD once, for
 * both checks. One whose Related line doesn't contain `PR #<number>` (not as the start of a longer number), or that
 * has no Related line, fails. So does a line of one (a fenced code line too) that states a count without a pin on the
 * same line (`unpinnedCount`):
 *   - a mutation count: a number in digits followed within three words by "edit(s)", "break(s)", "mutation(s)",
 *     "mutant(s)" or "killed", in any case ("11 mutate edits", "All 259 were killed", "36/36 killed"; r1/Q-2 on
 *     #240). A number right after `#`, a letter or digit, `.`, `:` or `-` (an issue, a version such as `v1.2`, a
 *     `file:line`, a name or date such as `B9-1` or `2026-10-11`), or right before `-`, isn't a count (one right
 *     before a letter has no word break to reach the keyword);
 *   - a gate result: a line with the word "gate" or "gates" (any case) and a `<n>/<n>` count, neither number joined
 *     to a letter, a digit, `/` or (before it) `#`.
 * A pin is a backticked 7–40 character hex SHA, an `actions/runs/<id>` link or a `/commit/<sha>` link. A count with no
 * number ("the PR's table lists each edit") needs none. A PR that adds no entry passes. The PR number is `--pr`, else
 * `PR_NUMBER`; the base is `--base`, else `PR_BASE` (the workflow passes the PR's base SHA), else `origin/main`. A PR's
 * first push is red until its "link PR #N" commit, since the number exists only once the PR does.
 *
 * Exit codes: 0 every added entry links the PR and pins its counts; 1 one doesn't; 2 the check couldn't run (bad
 * arguments, no PR number, no merge base with the base).
 */
import { parseArgs } from "node:util";

import { baseRef, namesSince, type ScriptDeps, scriptIo } from "./coverage-changed";

/** The value of an entry's `**<name>:**` line (Chapter, Milestone, Related), trimmed; none when it's missing or empty. */
export const field = (text: string, name: string): string | undefined =>
  new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.+?)\\s*$`, "m").exec(text)?.[1];

/** The value of an entry's `**Related:**` line, if it has one. */
export const relatedLine = (text: string): string | undefined => field(text, "Related");

/** True when `text` has a Related line naming `PR #<pr>`, and not only a longer number that starts with it. */
export function linksPr(text: string, pr: string): boolean {
  return new RegExp(`(?<![\\w#])PR #${pr}(?!\\d)`).test(relatedLine(text) ?? "");
}

/** A mutation count: digits (not inside an issue, version, `file:line`, name or date) and a word within three words. */
const MUTATION_COUNT =
  /(?<![#\w.:-])\d+(?!-)(?:[^\w\n]+\w+){0,2}?[^\w\n]+(?:edits?|breaks?|mutations?|mutants?|killed)\b/i;

/** A `<n>/<n>` count, on a line with the word "gate" or "gates". */
const GATE_COUNT = /(?<![\w/#])\d+\/\d+(?![\w/])/;

/** What pins a count: a backticked SHA, an Actions run link, or a commit link. */
const PIN = /`[0-9a-f]{7,40}`|actions\/runs\/\d+|\/commit\/[0-9a-f]{7,40}\b/;

/** True when `line` states a mutation or gate count and names no commit or run it was taken at. */
export const unpinnedCount = (line: string): boolean =>
  (MUTATION_COUNT.test(line) || (/\bgates?\b/i.test(line) && GATE_COUNT.test(line))) && !PIN.test(line);

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
    base = baseRef(values.base, vars.PR_BASE);
    pr = values.pr ?? vars.PR_NUMBER ?? "";
    if (!/^[1-9]\d*$/.test(pr)) throw new Error(`no PR number (got "${pr}"; pass --pr or set PR_NUMBER)`);
  } catch (err) {
    logError(`usage: journal-links [--base <ref>] [--pr <number>] (${(err as Error).message})`);
    return 2;
  }
  let added: string[];
  try {
    added = namesSince(git, base, "--diff-filter=A", ["docs/journal/"]).filter(isEntry);
  } catch (err) {
    logError(`journal-links: can't diff against ${base} (fetch the full history): ${(err as Error).message}`);
    return 2;
  }
  const texts = added.map((file) => ({ file, text: git("show", `HEAD:${file}`) }));
  const unlinked = texts.filter(({ text }) => !linksPr(text, pr)).map(({ file }) => file);
  const unpinned = texts.flatMap(({ file, text }) =>
    text.split("\n").flatMap((line, i) => (unpinnedCount(line) ? [`${file}:${i + 1}: ${line}`] : [])),
  );
  if (unlinked.length > 0) {
    log(`Journal entries this PR adds whose Related line doesn't name PR #${pr} (${unlinked.length}):`);
    for (const file of unlinked) log(file);
    logError(
      `journal-links: add \`PR #${pr}\` to each entry's **Related:** line, then commit and push ` +
        "(task-workflow step 7).",
    );
  }
  if (unpinned.length > 0) {
    log(
      `Journal lines this PR adds that state a mutation or gate count without a commit or run (${unpinned.length}):`,
    );
    for (const line of unpinned) log(line);
    logError(
      "journal-links: name the commit (a backticked SHA) or run (an actions/runs/<id> link) each count was taken " +
        "at, or point to the PR's table without a number (dev-journal skill, Evidence over adjectives).",
    );
  }
  if (unlinked.length + unpinned.length > 0) return 1;
  log(
    `journal-links: every journal entry added since ${base} names PR #${pr} and pins its counts ` +
      `(${added.length} added).`,
  );
  return 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
