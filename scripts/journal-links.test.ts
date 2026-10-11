/**
 * scripts/journal-links.ts: the Related-line match and the count check against hand-written entries and lines, and
 * `main` against a throwaway git repository whose feature branch adds, changes and deletes journal entries.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isEntry, linksPr, main, relatedLine, unpinnedCount } from "./journal-links";
import { gitRepo, logsTo, type TestRepo, withConsole } from "./test/git-repo";

const entry = (related?: string, ...body: string[]) =>
  [
    "# 2026-10-06 — An entry",
    "",
    "**Chapter:** 4. Teaching the agent to schedule",
    "**Milestone:** M2",
    ...(related === undefined ? [] : [`**Related:** ${related}`]),
    "",
    "Body that mentions PR #42 outside the Related line.",
    ...body,
  ].join("\n");

describe("linksPr", () => {
  it("finds PR #<n> anywhere on the Related line", () => {
    expect(linksPr(entry("#194, PR #42"), "42")).toBe(true);
    expect(linksPr(entry("PR #42"), "42")).toBe(true);
    expect(linksPr(entry("#194, PR #42, ADR-008"), "42")).toBe(true);
  });

  it("fails a line without it, a longer number, a bare issue reference, or an empty or missing Related line", () => {
    expect(linksPr(entry("#194, PR #188"), "42")).toBe(false);
    expect(linksPr(entry("PR #420"), "42")).toBe(false);
    expect(linksPr(entry("#42"), "42")).toBe(false);
    expect(linksPr(entry("XPR #42"), "42")).toBe(false);
    expect(linksPr(entry(), "42")).toBe(false);
    expect(relatedLine(entry())).toBeUndefined();
    // An empty Related line doesn't borrow the next line's text.
    expect(linksPr("**Related:**\n**Note:** PR #42", "42")).toBe(false);
  });
});

describe("unpinnedCount", () => {
  it("flags a mutation count in digits followed within three words by edit, break, mutation, mutant or killed", () => {
    for (const line of [
      "We ran 30 exact edits, and every one turned a test red.",
      "- Mutation edits: 11 mutate edits to the handler.",
      "83 exact edits",
      "All 259 were killed.",
      "re-ran them, all 36 killed (the PR's table)",
      "4 of 4 killed",
      "47 deliberate breaks",
      "25 MUTANTS of the handler",
      "1 mutation",
      "    12 edits: 12 killed, 0 survived",
    ])
      expect(unpinnedCount(line), line).toBe(true);
  });

  it("flags a gate result with an <n>/<n> count", () => {
    expect(unpinnedCount("The Eval gate passed at 13/14 in L1.")).toBe(true);
    expect(unpinnedCount("GATE run 2: 9/10")).toBe(true);
  });

  it("passes a count pinned by a backticked SHA, a run link or a commit link on the same line", () => {
    expect(unpinnedCount("all 36 edits killed at `3a88282`")).toBe(false);
    expect(unpinnedCount("[run](https://github.com/o/r/actions/runs/123456) showed Eval gate 13/14")).toBe(
      false,
    );
    expect(unpinnedCount("30 edits at https://github.com/o/r/commit/0123456789abcdef")).toBe(false);
  });

  it("passes a line with no count: an issue number, a number word, a name or date, too many words between", () => {
    for (const line of [
      "#212 now edits the prompt",
      "three edits to CLAUDE.md",
      "the PR's table lists each edit and the test it killed",
      "B9-1 edits, ADR-008 edits, and the 2026-10-11 edits",
      "4 tests in the new file, and the edits",
      "the gate ran twice",
      "13/14 cases passed",
      "a 3a88282 edits list",
      "`3a88282` names 4 killed",
    ])
      expect(unpinnedCount(line), line).toBe(false);
    // Not backticked, and too short to be a SHA: neither pins.
    expect(unpinnedCount("3a88282 had 4 killed")).toBe(true);
    expect(unpinnedCount("`3a8828` had 4 killed")).toBe(true);
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
    repo.write("docs/journal/2026-10-01-old.md", entry("#1", "30 edits, all killed."));
    // Unlike the entries the branch adds, so git doesn't pair one with it as a rename.
    repo.write("docs/journal/2026-10-02-gone.md", "# Gone\n\nSomething else entirely.\n");
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feature");
    // Changed and deleted entries, and the index, aren't this PR's to link.
    repo.write("docs/journal/2026-10-01-old.md", entry("#1, #3", "31 edits, all killed."));
    repo.git("rm", "-q", "docs/journal/2026-10-02-gone.md");
    repo.write("docs/journal/README.md", "# Journal\n\n| row |\n");
    repo.write(
      "docs/journal/2026-10-06-linked.md",
      entry("#194, PR #42", "", "We ran 12 edits at `abc1234`."),
    );
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
    expect(out).toEqual([
      "journal-links: every journal entry added since main names PR #42 and pins its counts (2 added).",
    ]);
  });

  it("fails naming each unpinned count line of an added entry, with or without an unlinked entry", () => {
    repo.write(
      "docs/journal/2026-10-06-linked.md",
      entry("#194, PR #42", "", "We ran 12 edits.", "", "```", "Eval gate: 13/14", "```"),
    );
    repo.commit("an unpinned count");
    expect(main(["--base", "main", "--pr", "42"], {}, deps())).toBe(1);
    expect(out).toEqual([
      "Journal entries this PR adds whose Related line doesn't name PR #42 (1):",
      "docs/journal/2026-10-06-café.md",
      "Journal lines this PR adds that state a mutation or gate count without a commit or run (2):",
      "docs/journal/2026-10-06-linked.md:9: We ran 12 edits.",
      "docs/journal/2026-10-06-linked.md:12: Eval gate: 13/14",
    ]);
    expect(errors[1]).toContain("point to the PR's table without a number");
    out.length = 0;
    repo.write("docs/journal/2026-10-06-café.md", entry("#194, PR #42"));
    repo.commit("link PR #42");
    expect(main(["--base", "main", "--pr", "42"], {}, deps())).toBe(1);
    expect(out[0]).toBe(
      "Journal lines this PR adds that state a mutation or gate count without a commit or run (2):",
    );
  });

  it("doesn't count an entry renamed since the base as added", () => {
    repo.write("docs/journal/2026-10-06-café.md", entry("#194, PR #42"));
    repo.git("mv", "docs/journal/2026-10-01-old.md", "docs/journal/2026-10-07-moved.md");
    repo.commit("link PR #42, rename an old entry");
    expect(main(["--base", "main", "--pr", "42"], {}, deps())).toBe(0);
    expect(out).toEqual([
      "journal-links: every journal entry added since main names PR #42 and pins its counts (2 added).",
    ]);
  });

  it("counts an entry moved into docs/journal/ from outside it as added", () => {
    repo.git("checkout", "-q", "main");
    repo.write("docs/draft.md", entry("#194"));
    repo.commit("a draft outside the journal");
    repo.git("checkout", "-q", "-b", "moved");
    repo.git("mv", "docs/draft.md", "docs/journal/2026-10-08-draft.md");
    repo.commit("move the draft into the journal");
    expect(main(["--base", "main", "--pr", "42"], {}, deps())).toBe(1);
    expect(out).toEqual([
      "Journal entries this PR adds whose Related line doesn't name PR #42 (1):",
      "docs/journal/2026-10-08-draft.md",
    ]);
  });

  it("doesn't count an added file under docs/journal/ that isn't an entry", () => {
    repo.write("docs/journal/diagram.svg", "<svg/>\n");
    repo.commit("add a diagram");
    main([], { PR_NUMBER: "42", PR_BASE: "main" }, deps());
    // Only the unlinked entry is named, not the diagram.
    expect(out.slice(1)).toEqual(["docs/journal/2026-10-06-café.md"]);
  });

  it("takes --pr and --base over PR_NUMBER and PR_BASE", () => {
    expect(main(["--pr", "42", "--base", "main"], { PR_NUMBER: "7", PR_BASE: "nope" }, deps())).toBe(1);
    expect(out).toEqual([
      "Journal entries this PR adds whose Related line doesn't name PR #42 (1):",
      "docs/journal/2026-10-06-café.md",
    ]);
  });

  it("reads the entry at HEAD, not in the working tree", () => {
    repo.write("docs/journal/2026-10-06-café.md", entry("#194, PR #42"));
    expect(main(["--base", "main"], { PR_NUMBER: "42" }, deps())).toBe(1);
  });

  it("passes a PR that adds no entry, defaulting the base to origin/main when PR_BASE is empty", () => {
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(main([], { PR_NUMBER: "42", PR_BASE: "" }, deps())).toBe(0);
    expect(out).toEqual([
      "journal-links: every journal entry added since origin/main names PR #42 and pins its counts (0 added).",
    ]);
  });

  it("exits 2 with no PR number, a bad one, an unknown option, or a base it can't diff against", () => {
    expect(main(["--base", "main"], {}, deps())).toBe(2);
    for (const bad of ["0", "42x", "x42"]) expect(main(["--base", "main", "--pr", bad], {}, deps())).toBe(2);
    expect(main(["--bogus"], { PR_NUMBER: "42" }, deps())).toBe(2);
    expect(errors.length).toBe(5);
    expect(errors.every((line) => line.startsWith("usage: journal-links"))).toBe(true);
    expect(errors[0]).toContain('no PR number (got ""');
    expect(main(["--base", "nope", "--pr", "42"], {}, deps())).toBe(2);
    expect(errors[5]).toContain("can't diff against nope");
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
