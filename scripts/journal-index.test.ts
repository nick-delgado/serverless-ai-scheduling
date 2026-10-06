/**
 * Journal entries and their index agree (#194, B7-2; deferred as B6-7 until it recurred in the reviews of PRs #162,
 * #165 and #191). Every `docs/journal/YYYY-MM-DD-*.md` entry has a `**Chapter:**` line naming a row of the "Rolling up
 * into the README" table in `.claude/skills/dev-journal/SKILL.md` (read from there, so the table stays the one
 * source) and a `**Milestone:**` line starting with that row's milestone code (`M0 Foundations` passes for chapter
 * 1). `docs/journal/README.md` has exactly one row for each entry, with the entry's chapter, and every row links to a
 * file that exists.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const journal = join(root, "docs", "journal");

/** An entry's file name: `YYYY-MM-DD-slug.md`. */
export const ENTRY = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

/** Chapter → milestone code, from the table under `## Rolling up into the README` in the dev-journal skill. */
export function chapters(skill: string): Map<string, string> {
  const section = skill.split(/^## Rolling up into the README\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return new Map(
    [...section.matchAll(/^\| (\d+\. [^|]*?) \| (M\d+) \|/gm)].map(([, chapter = "", code = ""]) => [
      chapter,
      code,
    ]),
  );
}

/** The index's rows: `| date | [title](file) | chapter |`, as the linked file and the Chapter cell. */
export function indexRows(readme: string): { file: string; chapter: string }[] {
  return [...readme.matchAll(/^\| [^|]* \| \[.*\]\(([^)]+)\) \| ([^|]*?) \|\s*$/gm)].map(
    ([, file = "", chapter = ""]) => ({ file, chapter }),
  );
}

/** The value of an entry's `**<field>:**` line, if it has one. */
export const field = (text: string, name: string): string | undefined =>
  new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s*$`, "m").exec(text)?.[1];

/** Every way the entries and the index disagree, one line each; empty when they agree. */
export function journalProblems(input: {
  chapters: Map<string, string>;
  entries: Map<string, string>;
  rows: { file: string; chapter: string }[];
  exists: (file: string) => boolean;
}): string[] {
  const problems: string[] = [];
  for (const [file, text] of input.entries) {
    const chapter = field(text, "Chapter");
    const milestone = field(text, "Milestone");
    if (chapter === undefined) problems.push(`${file}: no **Chapter:** line`);
    if (milestone === undefined) problems.push(`${file}: no **Milestone:** line`);
    const code = chapter === undefined ? undefined : input.chapters.get(chapter);
    if (chapter !== undefined && code === undefined)
      problems.push(`${file}: chapter "${chapter}" isn't a row of the dev-journal skill's table`);
    if (code !== undefined && milestone !== undefined && !new RegExp(`^${code}\\b`).test(milestone))
      problems.push(`${file}: milestone "${milestone}" doesn't start with ${code}, chapter "${chapter}"'s`);
    const rows = input.rows.filter((row) => row.file === file);
    if (rows.length !== 1) problems.push(`${file}: ${rows.length} rows in docs/journal/README.md, not 1`);
    for (const row of rows)
      if (chapter !== undefined && row.chapter !== chapter)
        problems.push(`${file}: README row says chapter "${row.chapter}", the entry "${chapter}"`);
  }
  for (const row of input.rows)
    if (!input.exists(row.file)) problems.push(`docs/journal/README.md: ${row.file} doesn't exist`);
  return problems;
}

const entry = (chapter?: string, milestone?: string) =>
  [
    "# 2026-10-06 — An entry",
    "",
    ...(chapter === undefined ? [] : [`**Chapter:** ${chapter}`]),
    ...(milestone === undefined ? [] : [`**Milestone:** ${milestone}`]),
    "**Related:** #1",
  ].join("\n");

describe("journalProblems", () => {
  const table = new Map([
    ["1. The question", "M0"],
    ["4. Teaching the agent to schedule", "M2"],
  ]);
  const check = (text: string, rows = [{ file: "a.md", chapter: "4. Teaching the agent to schedule" }]) =>
    journalProblems({ chapters: table, entries: new Map([["a.md", text]]), rows, exists: () => true });

  it("passes an entry whose chapter, milestone and one README row agree, a milestone with a name included", () => {
    expect(check(entry("4. Teaching the agent to schedule", "M2"))).toEqual([]);
    expect(
      check(entry("1. The question", "M0 Foundations"), [{ file: "a.md", chapter: "1. The question" }]),
    ).toEqual([]);
  });

  it("fails an entry with no Chapter or no Milestone line", () => {
    expect(check(entry(undefined, "M2"))).toEqual(["a.md: no **Chapter:** line"]);
    expect(check(entry("4. Teaching the agent to schedule"))).toEqual(["a.md: no **Milestone:** line"]);
  });

  it("fails a chapter that isn't a row of the skill's table", () => {
    expect(check(entry("7. Epilogue", "M2"), [{ file: "a.md", chapter: "7. Epilogue" }])).toEqual([
      "a.md: chapter \"7. Epilogue\" isn't a row of the dev-journal skill's table",
    ]);
  });

  it("fails a milestone that doesn't start with the chapter's code, M20 included", () => {
    for (const milestone of ["M3", "M20", "Foundations M2"])
      expect(check(entry("4. Teaching the agent to schedule", milestone))).toEqual([
        `a.md: milestone "${milestone}" doesn't start with M2, chapter "4. Teaching the agent to schedule"'s`,
      ]);
  });

  it("fails an entry with no README row, two, or one whose chapter differs", () => {
    const text = entry("4. Teaching the agent to schedule", "M2");
    const row = { file: "a.md", chapter: "4. Teaching the agent to schedule" };
    expect(check(text, [])).toEqual(["a.md: 0 rows in docs/journal/README.md, not 1"]);
    expect(check(text, [row, row])).toEqual(["a.md: 2 rows in docs/journal/README.md, not 1"]);
    expect(check(text, [{ file: "a.md", chapter: "1. The question" }])).toEqual([
      'a.md: README row says chapter "1. The question", the entry "4. Teaching the agent to schedule"',
    ]);
  });

  it("fails a README row that links to a file that doesn't exist", () => {
    const problems = journalProblems({
      chapters: table,
      entries: new Map(),
      rows: [{ file: "gone.md", chapter: "1. The question" }],
      exists: (file) => file !== "gone.md",
    });
    expect(problems).toEqual(["docs/journal/README.md: gone.md doesn't exist"]);
  });
});

describe("docs/journal", () => {
  const skillTable = chapters(
    readFileSync(join(root, ".claude", "skills", "dev-journal", "SKILL.md"), "utf8"),
  );
  const rows = indexRows(readFileSync(join(journal, "README.md"), "utf8"));
  const entries = new Map(
    readdirSync(journal)
      .filter((file) => ENTRY.test(file))
      .map((file) => [file, readFileSync(join(journal, file), "utf8")]),
  );

  it("parses the skill's table, the index and the entries (a format change must update this test, not silence it)", () => {
    expect(skillTable.get("1. The question")).toBe("M0");
    expect(skillTable.get("6. What I'd do next")).toBe("M4");
    expect(skillTable.size).toBe(6);
    expect(entries.size).toBeGreaterThan(40);
    expect(rows.length).toBeGreaterThan(40);
  });

  it("every entry's chapter and milestone match the skill's table and its one README row, and every row's file exists", () => {
    expect(
      journalProblems({
        chapters: skillTable,
        entries,
        rows,
        exists: (file) => existsSync(join(journal, file)),
      }),
    ).toEqual([]);
  });
});
