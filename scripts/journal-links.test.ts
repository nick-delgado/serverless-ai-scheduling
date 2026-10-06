/**
 * scripts/journal-links.ts: the Related-line match against hand-written entries, and `main` against a throwaway git
 * repository whose feature branch adds, changes and deletes journal entries.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isEntry, linksPr, main, relatedLine } from "./journal-links";
import { gitRepo, logsTo, type TestRepo, withConsole } from "./test/git-repo";

const entry = (related?: string) =>
  [
    "# 2026-10-06 — An entry",
    "",
    "**Chapter:** 4. Teaching the agent to schedule",
    "**Milestone:** M2",
    ...(related === undefined ? [] : [`**Related:** ${related}`]),
    "",
    "Body that mentions PR #42 outside the Related line.",
  ].join("\n");

describe("linksPr", () => {
  it("finds PR #<n> anywhere on the Related line", () => {
    expect(linksPr(entry("#194, PR #42"), "42")).toBe(true);
    expect(linksPr(entry("PR #42"), "42")).toBe(true);
    expect(linksPr(entry("#194, PR #42, ADR-008"), "42")).toBe(true);
  });

  it("fails a line without it, a longer number, a bare issue reference, or no Related line at all", () => {
    expect(linksPr(entry("#194, PR #188"), "42")).toBe(false);
    expect(linksPr(entry("PR #420"), "42")).toBe(false);
    expect(linksPr(entry("#42"), "42")).toBe(false);
    expect(linksPr(entry("XPR #42"), "42")).toBe(false);
    expect(linksPr(entry(), "42")).toBe(false);
    expect(relatedLine(entry())).toBeUndefined();
  });
});

describe("isEntry", () => {
  it("is a journal .md file other than the index", () => {
    expect(isEntry("docs/journal/2026-10-06-a.md")).toBe(true);
    expect(isEntry("docs/journal/README.md")).toBe(false);
    expect(isEntry("docs/journal/image.png")).toBe(false);
    expect(isEntry("docs/adr/0001-a.md")).toBe(false);
  });
});

describe("main", () => {
  let repo: TestRepo;
  let out: string[];
  let errors: string[];
  const deps = () => ({ cwd: repo.dir, ...logsTo(out, errors) });

  beforeEach(() => {
    repo = gitRepo("journal-links-");
    repo.write("docs/journal/README.md", "# Journal\n");
    repo.write("docs/journal/2026-10-01-old.md", entry("#1"));
    // Unlike the entries the branch adds, so git doesn't pair one with it as a rename.
    repo.write("docs/journal/2026-10-02-gone.md", "# Gone\n\nSomething else entirely.\n");
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feature");
    // Changed and deleted entries, and the index, aren't this PR's to link.
    repo.write("docs/journal/2026-10-01-old.md", entry("#1, #3"));
    repo.git("rm", "-q", "docs/journal/2026-10-02-gone.md");
    repo.write("docs/journal/README.md", "# Journal\n\n| row |\n");
    repo.write("docs/journal/2026-10-06-linked.md", entry("#194, PR #42"));
    repo.write("docs/journal/2026-10-06-café.md", entry("#194"));
    repo.write("docs/notes.md", entry("#194"));
    repo.commit("feature");
    out = [];
    errors = [];
  });
  afterEach(() => repo.remove());

  it("fails naming each added entry (one with a non-ASCII name) whose Related line lacks PR #<n>", () => {
    expect(main(["--base", "main", "--pr", "42"], {}, deps())).toBe(1);
    expect(out).toEqual([
      "Journal entries this PR adds whose Related line doesn't name PR #42 (1):",
      "docs/journal/2026-10-06-café.md",
    ]);
    expect(errors[0]).toContain("PR #42");
  });

  it("passes once every added entry links the PR, taking the number and base from PR_NUMBER and PR_BASE", () => {
    repo.write("docs/journal/2026-10-06-café.md", entry("#194, PR #42"));
    repo.commit("link PR #42");
    expect(main([], { PR_NUMBER: "42", PR_BASE: "main" }, deps())).toBe(0);
    expect(out).toEqual(["journal-links: every journal entry added since main names PR #42 (2 added)."]);
  });

  it("reads the entry at HEAD, not in the working tree", () => {
    repo.write("docs/journal/2026-10-06-café.md", entry("#194, PR #42"));
    expect(main(["--base", "main"], { PR_NUMBER: "42" }, deps())).toBe(1);
  });

  it("passes a PR that adds no entry, defaulting the base to origin/main when PR_BASE is empty", () => {
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(main([], { PR_NUMBER: "42", PR_BASE: "" }, deps())).toBe(0);
    expect(out).toEqual([
      "journal-links: every journal entry added since origin/main names PR #42 (0 added).",
    ]);
  });

  it("exits 2 with no PR number, a bad one, an unknown option, or a base it can't diff against", () => {
    expect(main(["--base", "main"], {}, deps())).toBe(2);
    expect(main(["--base", "main", "--pr", "0"], {}, deps())).toBe(2);
    expect(main(["--bogus"], { PR_NUMBER: "42" }, deps())).toBe(2);
    expect(errors.slice(0, 3).every((line) => line.startsWith("usage: journal-links"))).toBe(true);
    expect(errors[0]).toContain('no PR number (got ""');
    expect(main(["--base", "nope", "--pr", "42"], {}, deps())).toBe(2);
    expect(errors[3]).toContain("can't diff against nope");
  });

  it("logs to the console by default", async () => {
    await withConsole((log, error) => {
      expect(main(["--base", "main", "--pr", "42"], {}, { cwd: repo.dir })).toBe(1);
      expect(log).toHaveBeenCalledWith("docs/journal/2026-10-06-café.md");
      expect(main(["--bogus"], {})).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: journal-links"));
    });
  });
});
