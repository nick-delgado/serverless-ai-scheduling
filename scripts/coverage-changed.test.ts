/**
 * scripts/coverage-changed.ts against throwaway git repositories and hand-built coverage JSON in the shape
 * `npm run test:coverage` writes (istanbul entries from Vitest's v8 provider). The tests call `main`
 * in-process, because a child process records no coverage (#140).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkChanged,
  coverageByFile,
  type FileCoverage,
  hintWithoutReason,
  main,
  parseAddedLines,
  parseCliArgs,
  uncoveredLines,
} from "./coverage-changed";

/** A statement on lines `from`..`to` that ran `count` times. */
type Statement = [from: number, to: number, count: number];
/** A branch whose arms start on the given lines (undefined: no location) and ran the given counts. */
type Branch = { type?: string; arms: [line: number | undefined, count: number][] };

function fileCoverage(statements: Statement[], branches: Branch[] = []): FileCoverage {
  const coverage: FileCoverage = { statementMap: {}, s: {}, branchMap: {}, b: {} };
  statements.forEach(([from, to, count], i) => {
    coverage.statementMap[i] = { start: { line: from }, end: { line: to } };
    coverage.s[i] = count;
  });
  branches.forEach(({ type = "binary-expr", arms }, i) => {
    coverage.branchMap[i] = { type, locations: arms.map(([line]) => ({ start: line ? { line } : {} })) };
    coverage.b[i] = arms.map(([, count]) => count);
  });
  return coverage;
}

describe("parseAddedLines", () => {
  it("numbers each added line from its hunk's new start, per new path, and skips deleted files", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2 +2,2 @@ export function a() {",
      "-  return 1;",
      "+  const x = 1;",
      "+++ b/not-a-header",
      "@@ -9,0 +11 @@",
      "+  tail();",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old();",
    ].join("\n");
    expect([...parseAddedLines(diff)]).toEqual([
      [
        "src/a.ts",
        [
          { line: 2, text: "  const x = 1;" },
          { line: 3, text: "++ b/not-a-header" },
          { line: 11, text: "  tail();" },
        ],
      ],
    ]);
  });
});

describe("uncoveredLines", () => {
  it("flags every line of a statement that never ran, and none of one that ran", () => {
    expect([
      ...uncoveredLines(
        fileCoverage([
          [1, 3, 0],
          [5, 6, 2],
        ]),
      ),
    ]).toEqual([1, 2, 3]);
  });

  it("flags the start line of an arm that never ran, but not an arm without a location", () => {
    const branches: Branch[] = [
      {
        type: "binary-expr",
        arms: [
          [4, 3],
          [4, 0],
        ],
      },
      {
        type: "if",
        arms: [
          [7, 3],
          [undefined, 0],
        ],
      },
      {
        type: "cond-expr",
        arms: [
          [9, 0],
          [10, 1],
        ],
      },
    ];
    expect([...uncoveredLines(fileCoverage([[4, 10, 3]], branches))].sort()).toEqual([4, 9]);
  });
});

describe("hintWithoutReason", () => {
  it.each([
    ["/* v8 ignore next */", true],
    ["  /* v8 ignore start */ code();", true],
    ["// v8 ignore next", true],
    ["/* v8 ignore next -- @preserve */", true],
    ["/* v8 ignore next -- */ after(); // -- not the hint's reason", true],
    ["/* istanbul ignore if */", true],
    ["/* v8 ignore next -- CLI entry */", false],
    ["/* v8 ignore stop -- end of the AWS-only path */", false],
    ["// c8 ignore next -- @preserve only reached in the browser", false],
    ["const s = 'v8 ignore next'; // a string, not a hint", false],
    ["call(); // no hint here", false],
  ])("%s → %s", (line, expected) => {
    expect(hintWithoutReason(line)).toBe(expected);
  });
});

describe("checkChanged", () => {
  it("reports uncovered and unexplained added lines only for files with coverage", () => {
    const added = new Map([
      [
        "src/a.ts",
        [
          { line: 1, text: "ok();" },
          { line: 2, text: "never();" },
          { line: 3, text: "/* v8 ignore next */" },
        ],
      ],
      ["deploy.sh", [{ line: 2, text: "# v8 ignore next" }]],
    ]);
    const coverage = new Map([
      [
        "src/a.ts",
        fileCoverage([
          [1, 1, 1],
          [2, 2, 0],
        ]),
      ],
    ]);
    expect(checkChanged(added, coverage)).toEqual({
      uncovered: [{ file: "src/a.ts", line: 2 }],
      unexplained: [{ file: "src/a.ts", line: 3 }],
    });
  });
});

describe("coverageByFile", () => {
  it("keys entries by path relative to the root and drops files outside it", () => {
    const entry = fileCoverage([]);
    const byFile = coverageByFile(
      { "/repo/src/a.ts": entry, "/other/b.ts": entry, "/repo2/c.ts": entry },
      "/repo",
    );
    expect([...byFile.keys()]).toEqual(["src/a.ts"]);
  });
});

describe("parseCliArgs", () => {
  it("reads --base and --coverage", () => {
    expect(parseCliArgs(["--base", "abc", "--coverage", "c.json"])).toEqual({
      base: "abc",
      coverage: "c.json",
    });
    expect(parseCliArgs([])).toEqual({});
  });

  it.each([[["--bse", "x"]], [["--base"]], [["--base", "--coverage", "c.json"]]])("rejects %j", (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(/usage: coverage-changed/);
  });
});

describe("main", () => {
  let repo: string;
  let out: string[];
  let errors: string[];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  /** Writes coverage JSON keyed by absolute path, as Vitest does. */
  const writeCoverage = (files: Record<string, FileCoverage>, path = "coverage/coverage-final.json") =>
    write(
      path,
      JSON.stringify(Object.fromEntries(Object.entries(files).map(([f, c]) => [join(repo, f), c]))),
    );
  const run = (argv: string[] = ["--base", "main"], vars: Record<string, string | undefined> = {}) =>
    main(argv, vars, { cwd: repo, log: (l) => out.push(l), logError: (l) => errors.push(l) });

  // src/a.ts on main: lines 1-3. The branch then adds line 4 (and edits below per test).
  // src/old.ts: five kept lines and one the branch edits, so git sees a rename with an edit.
  const KEPT = [1, 2, 3, 4, 5].map((n) => `export const kept${n} = ${n};\n`).join("");
  const BASE = "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n";

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "coverage-changed-")));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    write(".gitignore", "coverage/\n");
    write("src/a.ts", BASE);
    write("src/old.ts", `${KEPT}export const edited = 1;\n`);
    commit("base");
    git("checkout", "-q", "-b", "feature");
    out = [];
    errors = [];
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails an uncovered added line, printing it as file:line", () => {
    write("src/a.ts", `${BASE}export const four = never();\n`);
    commit("add four");
    writeCoverage({
      "src/a.ts": fileCoverage([
        [1, 1, 1],
        [2, 2, 1],
        [3, 3, 1],
        [4, 4, 0],
      ]),
    });
    expect(run()).toBe(1);
    expect(out).toEqual(["Added lines no test executes (1):", "src/a.ts:4"]);
    expect(errors.join("\n")).toMatch(/give each line above a test, or an ignore hint with a reason/);
  });

  it("passes a covered added line", () => {
    write("src/a.ts", `${BASE}export const four = 4;\n`);
    commit("add four");
    writeCoverage({ "src/a.ts": fileCoverage([[1, 4, 1]]) });
    expect(run()).toBe(0);
    expect(out).toEqual(["coverage-changed: every added source line since main ran in a test."]);
    expect(errors).toEqual([]);
  });

  it.each([
    ["?? right operand", "export const four = (process.env.X ?? fallback());"],
    ["|| right operand", "export const four = (process.env.X || fallback());"],
    ["ternary arm", "export const four = process.env.X ? 1 : fallback();"],
  ])("fails an added line whose statement ran but whose %s never did", (_, line) => {
    write("src/a.ts", `${BASE}${line}\n`);
    commit("add four");
    writeCoverage({
      "src/a.ts": fileCoverage(
        [[1, 4, 1]],
        [
          {
            arms: [
              [4, 1],
              [4, 0],
            ],
          },
        ],
      ),
    });
    expect(run()).toBe(1);
    expect(out).toEqual(["Added lines no test executes (1):", "src/a.ts:4"]);
  });

  it("passes an ignore hint with a reason (the hinted code is absent from the coverage JSON)", () => {
    write("src/a.ts", `${BASE}/* v8 ignore next -- only reachable on AWS */\nif (aws()) run();\n`);
    commit("add hint");
    writeCoverage({ "src/a.ts": fileCoverage([[1, 3, 1]]) });
    expect(run()).toBe(0);
  });

  it("fails an added ignore hint with no reason, printing it as file:line", () => {
    write("src/a.ts", `${BASE}/* v8 ignore next */\nif (aws()) run();\n`);
    commit("add hint");
    writeCoverage({ "src/a.ts": fileCoverage([[1, 3, 1]]) });
    expect(run()).toBe(1);
    expect(out).toEqual(['Coverage ignore hints without a reason after "--" (1):', "src/a.ts:4"]);
  });

  it("ignores removed and unchanged lines, even uncovered ones", () => {
    write("src/a.ts", "export const one = 1;\nexport const three = 3;\n");
    commit("remove two");
    // Line 1 (unchanged) never ran; line 2 was line 3 before and is unchanged too.
    writeCoverage({
      "src/a.ts": fileCoverage([
        [1, 1, 0],
        [2, 2, 0],
      ]),
    });
    expect(run()).toBe(0);
  });

  it("ignores files outside the coverage include: shell, Markdown, CSS and tests", () => {
    write("scripts/deploy.sh", "echo never\n");
    write("docs/note.md", "/* v8 ignore next */\n");
    write("src/style.css", "a { color: red; }\n");
    write("src/a.test.ts", "never();\n");
    commit("non-source");
    writeCoverage({ "src/a.ts": fileCoverage([[1, 3, 0]]) });
    expect(run()).toBe(0);
  });

  it("counts only the edits in a renamed file", () => {
    git("mv", "src/old.ts", "src/new.ts");
    write("src/new.ts", `${KEPT}export const edited = never();\n`);
    commit("rename and edit");
    writeCoverage({
      "src/new.ts": fileCoverage([
        [1, 5, 0],
        [6, 6, 0],
      ]),
    });
    expect(run()).toBe(1);
    expect(out).toEqual(["Added lines no test executes (1):", "src/new.ts:6"]);
  });

  it("checks committed changes only, not the working tree", () => {
    write("src/a.ts", `${BASE}export const four = never();\n`);
    writeCoverage({ "src/a.ts": fileCoverage([[4, 4, 0]]) });
    expect(run()).toBe(0);
  });

  it("reads the coverage file given by --coverage", () => {
    write("src/a.ts", `${BASE}export const four = never();\n`);
    commit("add four");
    writeCoverage({ "src/a.ts": fileCoverage([[4, 4, 0]]) }, "elsewhere/c.json");
    expect(run(["--base", "main", "--coverage", "elsewhere/c.json"])).toBe(1);
  });

  it("exits 2 and says to run test:coverage when there is no coverage JSON", () => {
    expect(run()).toBe(2);
    expect(errors.join("\n")).toMatch(/coverage-final\.json; run `npm run test:coverage` first/);
  });

  it("exits 2 on bad arguments", () => {
    expect(run(["--nope"])).toBe(2);
    expect(errors.join("\n")).toMatch(/usage: coverage-changed/);
  });

  describe("base ref", () => {
    // The branch's uncovered line 4 shows which base was used: `later` is the branch head, so nothing is added since it.
    beforeEach(() => {
      write("src/a.ts", `${BASE}export const four = never();\n`);
      commit("feature adds four");
      writeCoverage({ "src/a.ts": fileCoverage([[4, 4, 0]]) });
      git("update-ref", "refs/remotes/origin/main", "main");
      git("update-ref", "refs/heads/later", "HEAD");
    });

    it("defaults to origin/main", () => {
      expect(run([])).toBe(1);
      expect(out).toContain("src/a.ts:4");
    });

    it("uses COVERAGE_BASE, and --base over it", () => {
      expect(run([], { COVERAGE_BASE: "later" })).toBe(0);
      expect(out.at(-1)).toMatch(/since later ran/);
      expect(run(["--base", "main"], { COVERAGE_BASE: "later" })).toBe(1);
    });

    it("treats an empty COVERAGE_BASE (a push run) as unset", () => {
      expect(run([], { COVERAGE_BASE: "" })).toBe(1);
    });

    it("without a merge base: exits 2 in CI, and warns and passes locally", () => {
      expect(run(["--base", "no-such-ref"], { CI: "true" })).toBe(2);
      expect(errors.at(-1)).toMatch(/no merge base with no-such-ref \(CI must fetch the full history\)/);
      expect(run(["--base", "no-such-ref"], {})).toBe(0);
      expect(errors.at(-1)).toMatch(/SKIPPING: no merge base with no-such-ref/);
    });
  });

  it("logs to the console by default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(main(["--base", "main"], {}, { cwd: repo })).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/run `npm run test:coverage` first/));
      writeCoverage({});
      expect(main(["--base", "main"], {}, { cwd: repo })).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/every added source line since main/));
      // No deps at all: git runs in the process's directory, which still parses the arguments first.
      expect(main(["--nope"], {})).toBe(2);
      expect(error).toHaveBeenLastCalledWith(expect.stringMatching(/usage: coverage-changed/));
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
