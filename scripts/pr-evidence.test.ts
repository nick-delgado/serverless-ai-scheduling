/**
 * scripts/pr-evidence.ts: the table parser against hand-written PR bodies, and `main` against a throwaway git
 * repository whose feature branch adds, changes, renames and deletes files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SOURCE_GLOBS } from "./coverage-changed";
import { type EditResult, MARKDOWN_HEADER, markdownTable } from "./mutate";
import { EVIDENCE_GLOBS, killedFiles, main, missingEvidence } from "./pr-evidence";
import { gitRepo, logsTo, type TestRepo, withConsole } from "./test/git-repo";

const table = (...files: string[]) =>
  [
    MARKDOWN_HEADER,
    "|---|---|---|---|---|",
    ...files.map((f) => `| 1 | \`${f}\` | \`a\` → \`b\` | KILLED | — |`),
  ].join("\n");

describe("killedFiles", () => {
  it("reads the File cell of every row of every mutate table, CRLF bodies included", () => {
    const body = [
      // Rows outside a table, KILLED status included, name nothing.
      "| Intro | `not/a/table.ts` | c | KILLED | — |",
      // Indented, as inside a list item or <details>.
      table("scripts/a.ts", "packages/x/src/b.ts").replaceAll("\n", "\n  ").replace(/^/, "  "),
      "",
      "| 2 | `scripts/after-the-table.ts` | c | KILLED | — |",
      table("scripts/c.ts").replaceAll("\n", "\r\n"),
    ].join("\n");
    expect([...killedFiles(body)]).toEqual(["scripts/a.ts", "packages/x/src/b.ts", "scripts/c.ts"]);
  });

  it("ends a table at the first line that isn't a row", () => {
    expect([
      ...killedFiles(`${table("scripts/a.ts")}\ntext\n| 2 | \`scripts/b.ts\` | c | KILLED | — |`),
    ]).toEqual(["scripts/a.ts"]);
  });

  it("reads a file in a longer fence, or with escaped pipes in the cells before it", () => {
    const body = [
      MARKDOWN_HEADER,
      "|---|---|---|---|---|",
      "| a\\|b | `` scripts/`x`.ts `` | c | KILLED | e |",
      "| a row with no file |",
      "| 2 | | c | KILLED | e |",
    ].join("\n");
    expect([...killedFiles(body)]).toEqual(["scripts/`x`.ts"]);
  });

  it("counts a file only for a KILLED or KILLED (no expect) row, so one KILLED row among others is enough", () => {
    const rows = (file: string, ...statuses: string[]) =>
      statuses.map((status) => `| 1 | \`${file}\` | \`a\` → \`b\` | ${status} | — |`);
    const body = [
      MARKDOWN_HEADER,
      "|---|---|---|---|---|",
      ...rows("scripts/killed.ts", "SURVIVED", "KILLED"),
      ...rows("scripts/no-expect.ts", "KILLED (no expect)"),
      ...rows("scripts/other.ts", "KILLED-OTHER (expected: x)", "SURVIVED", "TIMEOUT", "ERROR"),
      ...rows("scripts/refused.ts", "REFUSED (find occurs 2 times)", "KILLED (expected: x)"),
    ].join("\n");
    expect([...killedFiles(body)]).toEqual(["scripts/killed.ts", "scripts/no-expect.ts"]);
  });

  it("reads npm run mutate's own --markdown table, a file in a longer fence included", () => {
    const result = (file: string, status: "KILLED" | "SURVIVED", expect?: string[]): EditResult => ({
      id: file,
      file,
      find: "a | b",
      replace: "c",
      status,
      failedTests: status === "KILLED" ? ["t.test.ts > x"] : [],
      seconds: 1,
      ...(expect ? { expect } : {}),
    });
    const body = markdownTable([
      result("scripts/a.ts", "KILLED", ["x"]),
      result("scripts/b.ts`", "KILLED"),
      result("scripts/c.ts", "SURVIVED"),
    ]).join("\n");
    expect([...killedFiles(body)]).toEqual(["scripts/a.ts", "scripts/b.ts`"]);
  });

  it("finds nothing without the header", () => {
    expect(killedFiles(table("scripts/a.ts").replace("| Edit |", "| Id |")).size).toBe(0);
  });
});

describe("missingEvidence", () => {
  const changed = [
    "scripts/a.ts",
    "scripts/a.test.ts",
    "packages/x/src/b.ts",
    "packages/x/test/c.ts",
    "apps/web/src/d.d.ts",
    "apps/web/src/test/setup.ts",
    "spikes/s/run.ts",
    "docs/e.md",
  ];

  it("lists the changed source files no table names, ignoring tests, test/ helpers (in src too), .d.ts, spikes and docs", () => {
    expect(missingEvidence(changed, table("scripts/a.ts"), EVIDENCE_GLOBS)).toEqual(["packages/x/src/b.ts"]);
    expect(missingEvidence(changed, "", EVIDENCE_GLOBS)).toEqual(["scripts/a.ts", "packages/x/src/b.ts"]);
    expect(missingEvidence(changed, table("scripts/a.ts", "packages/x/src/b.ts"), EVIDENCE_GLOBS)).toEqual(
      [],
    );
  });

  it("covers the coverage gate's source files less test/ directories, leaving the gate's own globs as they are", () => {
    expect(EVIDENCE_GLOBS).toEqual({
      include: SOURCE_GLOBS.include,
      exclude: [...SOURCE_GLOBS.exclude, "**/test/**"],
    });
    expect(SOURCE_GLOBS.exclude).not.toContain("**/test/**");
  });

  it("matches a path exactly, not as a suffix", () => {
    expect(missingEvidence(["packages/x/src/b.ts"], table("src/b.ts"), SOURCE_GLOBS)).toEqual([
      "packages/x/src/b.ts",
    ]);
  });
});

describe("main", () => {
  let repo: TestRepo;
  let out: string[];
  let errors: string[];
  const deps = () => ({ cwd: repo.dir, ...logsTo(out, errors) });
  const write = (file: string) => repo.write(file, "export const x = 1;\n");

  beforeEach(() => {
    repo = gitRepo("pr-evidence-");
    repo.write("scripts/gone.ts", "export const gone = 1;\n");
    repo.write("scripts/old.ts", "a\nb\nc\nd\ne\nf\n");
    write("scripts/kept.ts");
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feature");
    repo.git("rm", "-q", "scripts/gone.ts");
    repo.git("mv", "scripts/old.ts", "scripts/new.ts");
    repo.write("scripts/kept.ts", "export const x = 2;\n");
    // A non-ASCII name, which git quotes unless told not to.
    repo.write("scripts/café.ts", "export const y = 1;\n");
    write("scripts/kept.test.ts");
    repo.write("docs/a.md", "# a\n");
    repo.commit("feature");
    out = [];
    errors = [];
  });
  afterEach(() => repo.remove());

  it("fails naming the added (one with a non-ASCII name), changed and renamed source files the body leaves out, not deleted ones", () => {
    expect(main(["--base", "main"], { PR_BODY: table("scripts/kept.ts") }, deps())).toBe(1);
    expect(out).toEqual([
      "Changed source files with no KILLED row in a mutate table in the PR body (2):",
      "scripts/café.ts",
      "scripts/new.ts",
    ]);
    expect(errors[0]).toContain("--markdown");
  });

  it("passes when every changed source file is named, taking the base from PR_BASE", () => {
    const body = table("scripts/kept.ts", "scripts/new.ts", "scripts/café.ts");
    expect(main([], { PR_BODY: body, PR_BASE: "main" }, deps())).toBe(0);
    expect(out).toEqual([
      "pr-evidence: every changed source file since main has a KILLED row in a mutate table.",
    ]);
  });

  it("passes a docs-only and test-only PR with no body, a test/ helper inside src included", () => {
    repo.git("checkout", "-q", "main");
    repo.git("checkout", "-q", "-b", "docs");
    repo.write("docs/b.md", "# b\n");
    write("scripts/kept.test.ts");
    write("apps/web/src/test/setup.ts");
    repo.commit("docs");
    expect(main(["--base", "main"], {}, deps())).toBe(0);
  });

  it("defaults the base to origin/main, and an empty PR_BASE counts as unset", () => {
    // origin/main at the branch's head: nothing changed since it, where main would have changes.
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(main([], { PR_BODY: "", PR_BASE: "" }, deps())).toBe(0);
    expect(out).toEqual([
      "pr-evidence: every changed source file since origin/main has a KILLED row in a mutate table.",
    ]);
  });

  it("exits 2 when it can't diff against the base, or for an unknown option", () => {
    expect(main(["--base", "nope"], {}, deps())).toBe(2);
    expect(errors[0]).toContain("can't diff against nope");
    expect(main(["--bogus"], {}, deps())).toBe(2);
    expect(errors[1]).toContain("usage: pr-evidence");
  });

  it("logs to the console by default", async () => {
    await withConsole((log, error) => {
      const body = table("scripts/kept.ts", "scripts/new.ts", "scripts/café.ts");
      expect(main(["--base", "main"], { PR_BODY: body }, { cwd: repo.dir })).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("every changed source file"));
      expect(main(["--bogus"], {})).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: pr-evidence"));
    });
  });
});
