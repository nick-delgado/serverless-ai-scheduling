/**
 * PR body check (#265, B10-1; from the reviews of PRs #253 and #255, STD-1, #261, VER-1, and #254 and #258, STD-2): the
 * PR's title and body follow `task-workflow` step 7 and `.github/pull_request_template.md`.
 *
 *   tsx scripts/pr-body.ts      (the title comes from PR_TITLE, the body from PR_BODY)
 *
 * It fails, naming each problem, when:
 *   - the title isn't `<type>: <summary> (#<N>…)` or `<type>(<scope>): <summary> (#<N>…)` (`SKILL.md` step 7 gives the
 *     scoped form; r1/Q-1 (a) made the scope optional). `<type>` is lowercase and one of `TITLE_TYPES`; a scope is any
 *     non-empty text without parentheses; the `(#<N>…)` group ends the title, and may go on after the number
 *     after a comma, semicolon or space (`(#38, part 1 of 2)`). A breaking-change `!` and an issue-style title (`[M3] …`) fail;
 *   - the body says `Refs #<N>` and a GitHub closing keyword (`CLOSING_KEYWORDS`, any case, an optional colon, then
 *     whitespace) comes right before the same `#<N>` anywhere in it: in prose, code spans, fenced blocks and HTML
 *     comments too (r1/Q-4 (a)), since GitHub closes the issue on prose too (#261, VER-1). `Refs` matches the same
 *     way. Only the `#<N>` form is read: `Closes https://github.com/…/issues/38` and `owner/repo#38` aren't, a gap;
 *   - the `## Decisions the spec left open` section, from that exact line to a line starting `**Departs from` or the
 *     next line starting `## `, holds a list item: a line starting, after any indentation, with `- `, `* `, `+ `, or
 *     digits followed by `. ` or `) `, outside an HTML comment and a fenced code block (r1/Q-6 (a)). The template asks
 *     for one list, in the journal entry, linked from here ("a second list drifts"); `None` or a link passes.
 * It doesn't read commit messages, and doesn't require a `Closes` or `Refs` line. GitHub sends no body for an empty
 * description, so an unset `PR_BODY` is an empty body.
 *
 * Copies: `TITLE_TYPES` restates the branch types of `task-workflow` step 3 (`.claude/skills/task-workflow/SKILL.md`,
 * the `pr-title-types` sync region) plus `test`; `CLOSING_KEYWORDS` restates the pattern in the pinned harness script
 * `.agents/skills/review-agent-pr/scripts/get-pr.sh`, which can't be imported.
 *
 * Exit codes: 0 the title and body pass; 1 a problem, each named; 2 the check couldn't run (an argument, no PR_TITLE).
 */
import { parseArgs } from "node:util";

import { type ScriptDeps, scriptIo } from "./coverage-changed";

// sync-start:pr-title-types (restated in .claude/skills/task-workflow/SKILL.md, step 3's branch types)
/** The title's `<type>`: the branch types of `task-workflow` step 3, plus `test`. */
export const TITLE_TYPES = ["feat", "fix", "infra", "spike", "docs", "eval", "chore", "test"];
// sync-end:pr-title-types

const TITLE = new RegExp(
  `^(?:${TITLE_TYPES.join("|")})(?:\\([^()]+\\))?: \\S.* \\(#\\d+(?:[,; ][^()]*)?\\)$`,
);

/** GitHub's closing keywords, as a pattern (the same words as `get-pr.sh`'s). */
const CLOSING_KEYWORDS = "close[sd]?|fix(?:e[sd])?|resolve[sd]?";

/** True when `title` has the form `task-workflow` step 7 gives it (see the header). */
export const titleOk = (title: string): boolean => TITLE.test(title);

/** The issue numbers `body` says `Refs #<N>` for and also closes with a keyword right before `#<N>`, in order. */
export function refsAndCloses(body: string): string[] {
  const refs = [...body.matchAll(/\brefs:?\s+#(\d+)(?!\d)/gi)].map((m) => m[1] as string); // the group always takes part
  const closes = (n: string) => new RegExp(`\\b(?:${CLOSING_KEYWORDS}):?\\s+#${n}(?!\\d)`, "i").test(body);
  return [...new Set(refs)].filter(closes);
}

const DECISIONS_HEADING = "## Decisions the spec left open";
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)]) /;
const FENCE = /^\s*(?:```|~~~)/;

/** The list items in `body`'s "Decisions the spec left open" section, outside HTML comments and fenced blocks. */
export function decisionItems(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.indexOf(DECISIONS_HEADING);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("**Departs from") || line.startsWith("## "));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const items: string[] = [];
  let fenced = false;
  for (const line of section.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced && LIST_ITEM.test(line)) items.push(line.trim());
  }
  return items;
}

/** Each problem with `title` and `body`, as a line to print; empty when both pass. */
export function problems(title: string, body: string): string[] {
  const found: string[] = [];
  if (!titleOk(title))
    found.push(
      `title: "${title}" isn't "<type>(<scope>): <summary> (#<N>)" (the scope is optional; <type> is one of ` +
        `${TITLE_TYPES.join(", ")}; task-workflow step 7).`,
    );
  for (const n of refsAndCloses(body))
    found.push(
      `body: says Refs #${n} and also has a closing keyword right before #${n}, which closes the issue on merge; ` +
        `write the earlier parts of a split issue without one (task-workflow step 7).`,
    );
  const items = decisionItems(body);
  if (items.length > 0)
    found.push(
      `body: "${DECISIONS_HEADING}" holds a list (${items.join(" / ")}); list the ` +
        `decisions once, in the journal entry's "Why we chose", and link it there.`,
    );
  return found;
}

/** The script's entry point; returns the exit code (see the header). `vars` is the process environment. */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: ScriptDeps = {},
): number {
  const { log, logError } = scriptIo(deps);
  try {
    parseArgs({ args: [...argv], options: {}, strict: true });
    if (vars.PR_TITLE === undefined) throw new Error("PR_TITLE isn't set");
  } catch (err) {
    logError(`usage: pr-body (PR_TITLE and PR_BODY in the environment) (${(err as Error).message})`);
    return 2;
  }
  const found = problems(vars.PR_TITLE, vars.PR_BODY ?? "");
  if (found.length > 0) {
    log(`The PR's title or body has ${found.length} problem(s):`);
    for (const line of found) log(line);
    logError("pr-body: fix the title or body above, then the check reruns on the edit (no push needed).");
    return 1;
  }
  log("pr-body: the title and body pass.");
  return 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
