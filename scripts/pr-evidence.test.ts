/**
 * scripts/pr-evidence.ts: the table parser against hand-written PR bodies, and `main` against a throwaway git
 * repository whose feature branch adds, changes, renames and deletes files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SOURCE_GLOBS } from "./coverage-changed";
import { MARKDOWN_HEADER } from "./mutate";
import { main, missingEvidence, namedFiles } from "./pr-evidence";
import { gitRepo, logsTo, type TestRepo, withConsole } from "./test/git-repo";

const table = (...files: string[]) =>
  [
    MARKDOWN_HEADER,
    "|---|---|---|---|---|",
    ...files.map((f) => `| 1 | \`${f}\` | \`a\` → \`b\` | KILLED | — |`),
  ].join("\n");

describe("namedFiles", () => {
  it("reads the File cell of every row of every mutate table, CRLF bodies included", () => {
    const body = [
      "| Intro | `not/a/table.ts` |",
      // Indented, as inside a list item or <details>.
      table("scripts/a.ts", "packages/x/src/b.ts").replaceAll("\n", "\n  ").replace(/^/, "  "),
      "",
      "| `scripts/after-the-table.ts` |",
      table("scripts/c.ts").replaceAll("\n", "\r\n"),
    ].join("\n");
    expect([...namedFiles(body)]).toEqual(["scripts/a.ts", "packages/x/src/b.ts", "scripts/c.ts"]);
  });

  it("ends a table at the first line that isn't a row", () => {
    expect([...namedFiles(`${table("scripts/a.ts")}\ntext\n| 2 | \`scripts/b.ts\` |`)]).toEqual([
      "scripts/a.ts",
    ]);
  });

  it("reads a file in a longer fence, or with escaped pipes in the cells before it", () => {
    const body = [
      MARKDOWN_HEADER,
      "|---|---|---|---|---|",
      "| a\\|b | `` scripts/`x`.ts `` | c | d | e |",
      "| a row with no file |",
    ].join("\n");
    expect([...namedFiles(body)]).toEqual(["scripts/`x`.ts"]);
  });

  it("finds nothing without the header", () => {
    expect(namedFiles(table("scripts/a.ts").replace("| Edit |", "| Id |")).size).toBe(0);
  });
});

describe("missingEvidence", () => {
  const changed = [
    "scripts/a.ts",
    "scripts/a.test.ts",
    "packages/x/src/b.ts",
    "packages/x/test/c.ts",
    "apps/web/src/d.d.ts",
    "spikes/s/run.ts",
    "docs/e.md",
  ];

  it("lists the changed source files no table names, ignoring tests, test/ helpers, .d.ts, spikes and docs", () => {
    expect(missingEvidence(changed, table("scripts/a.ts"), SOURCE_GLOBS)).toEqual(["packages/x/src/b.ts"]);
    expect(missingEvidence(changed, "", SOURCE_GLOBS)).toEqual(["scripts/a.ts", "packages/x/src/b.ts"]);
    expect(missingEvidence(changed, table("scripts/a.ts", "packages/x/src/b.ts"), SOURCE_GLOBS)).toEqual([]);
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
      "Changed source files no mutate table in the PR body names (2):",
      "scripts/café.ts",
      "scripts/new.ts",
    ]);
    expect(errors[0]).toContain("--markdown");
  });

  it("passes when every changed source file is named, taking the base from PR_BASE", () => {
    const body = table("scripts/kept.ts", "scripts/new.ts", "scripts/café.ts");
    expect(main([], { PR_BODY: body, PR_BASE: "main" }, deps())).toBe(0);
    expect(out).toEqual(["pr-evidence: every changed source file since main is in a mutate table."]);
  });

  it("passes a docs-only and test-only PR with no body", () => {
    repo.git("checkout", "-q", "main");
    repo.git("checkout", "-q", "-b", "docs");
    repo.write("docs/b.md", "# b\n");
    write("scripts/kept.test.ts");
    repo.commit("docs");
    expect(main(["--base", "main"], {}, deps())).toBe(0);
  });

  it("defaults the base to origin/main, and an empty PR_BASE counts as unset", () => {
    // origin/main at the branch's head: nothing changed since it, where main would have changes.
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(main([], { PR_BODY: "", PR_BASE: "" }, deps())).toBe(0);
    expect(out).toEqual(["pr-evidence: every changed source file since origin/main is in a mutate table."]);
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
