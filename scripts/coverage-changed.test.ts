/**
 * scripts/coverage-changed.ts against throwaway git repositories and hand-built coverage JSON in the shape
 * `npm run test:coverage` writes (istanbul entries from Vitest's v8 provider). Most tests call the script's
 * functions in-process, because a child process records no coverage (#140): the `main` tests drive the whole
 * check against a throwaway repository. One test spawns the script to check its exit code, and the
 * tests of the coverage globs check the exported globs against the repository's own `src` trees.
 */
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config";

import {
  baseRef,
  checkChanged,
  coverageByFile,
  type FileCoverage,
  hintWithoutReason,
  isSourceFile,
  main,
  namesSince,
  parseAddedLines,
  parseCliArgs,
  SOURCE_GLOBS,
  type SourceGlobs,
  uncoveredLines,
} from "./coverage-changed";
import { gitRepo, type TestRepo, withConsole } from "./test/git-repo";

/** Source globs for the throwaway repositories, whose source lives in `src/`. */
const TEST_GLOBS: SourceGlobs = { include: ["src/**/*.{ts,tsx}"], exclude: SOURCE_GLOBS.exclude };

/** A statement on lines `from`..`to` that ran `count` times. */
type Statement = [from: number, to: number, count: number];
/** A branch whose arms start on the given lines (undefined: no location) and ran the given counts. */
type Branch = { arms: [line: number | undefined, count: number][] };

function fileCoverage(statements: Statement[], branches: Branch[] = []): FileCoverage {
  const coverage: FileCoverage = { statementMap: {}, s: {}, branchMap: {}, b: {} };
  statements.forEach(([from, to, count], i) => {
    coverage.statementMap[i] = { start: { line: from }, end: { line: to } };
    coverage.s[i] = count;
  });
  branches.forEach(({ arms }, i) => {
    coverage.branchMap[i] = { locations: arms.map(([line]) => ({ start: line ? { line } : {} })) };
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
      // A binary-expr (`a ?? b`) whose right operand never ran.
      {
        arms: [
          [4, 3],
          [4, 0],
        ],
      },
      // An `if` with no `else`: the implicit else arm has no location.
      {
        arms: [
          [7, 3],
          [undefined, 0],
        ],
      },
      // A cond-expr (ternary) whose first arm never ran.
      {
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
    ["/* v8 ignore else */", true],
    ["/* v8 ignore stop */", true],
    ["const remaining = count -- 1; /* v8 ignore next */", true],
    ["/* c8 ignore file */", true],
    ["/* node:coverage ignore next */", true],
    ["/** v8 ignore next */", true],
    ["/** v8 ignore if */ if (aws()) run();", true],
    ["/* TODO v8 ignore start */", true],
    ["code(); // later: v8 ignore stop", true],
    ["const s = 'v8 ignore start'; // the provider reads start/stop anywhere on a line", true],
    ["  v8 ignore next", true],
    ["/** v8 ignore next -- only on AWS */", false],
    ["/* TODO v8 ignore start -- the AWS-only path */", false],
    ["// v8 ignore next -- x", false],
    ["/* v8 ignore nextline */", false],
    ["/* v8 ignore next -- CLI entry */", false],
    ["/* v8 ignore stop -- end of the AWS-only path */", false],
    ["// c8 ignore next -- @preserve only reached in the browser", false],
    ["  v8 ignore next -- the line after a /* opener", false],
    ["const s = 'v8 ignore next'; // a string, not a hint", false],
    ["call(); // no hint here", false],
  ])("%s → %s", (line, expected) => {
    expect(hintWithoutReason(line)).toBe(expected);
  });
});

describe("isSourceFile", () => {
  it.each([
    ["src/a.ts", true],
    ["src/ui/b.tsx", true],
    ["src/a.test.ts", false],
    ["src/types.d.ts", false],
    ["docs/note.md", false],
    ["lib/a.ts", false],
  ])("%s → %s", (file, expected) => {
    expect(isSourceFile(file, TEST_GLOBS)).toBe(expected);
  });
});

describe("the coverage globs in vitest.config.ts (AC 1)", () => {
  // The expected sets come from the repository's layout: each workspace's `src` tree and `scripts/`.
  const root = join(import.meta.dirname, "..");
  const list = (pattern: string) => globSync(pattern, { cwd: root }).sort();
  const trees = {
    packages: list("packages/*/src/**/*.{ts,tsx}"),
    services: list("services/*/src/**/*.{ts,tsx}"),
    apps: list("apps/*/src/**/*.{ts,tsx}"),
    scripts: list("scripts/*.ts"),
  };
  const isTest = (file: string) => /\.test\.tsx?$/.test(file);

  it.each(Object.entries(trees))("include every non-test source file under %s, and no test", (_, files) => {
    const sources = files.filter((f) => !isTest(f) && !f.endsWith(".d.ts"));
    expect(sources.length).toBeGreaterThan(0);
    expect(files.some(isTest)).toBe(true);
    expect(sources.filter((f) => !isSourceFile(f, SOURCE_GLOBS))).toEqual([]);
    expect(files.filter(isTest).filter((f) => isSourceFile(f, SOURCE_GLOBS))).toEqual([]);
  });

  it("include the web app's .tsx components", () => {
    const components = trees.apps.filter((f) => f.endsWith(".tsx") && !isTest(f));
    expect(components.length).toBeGreaterThan(0);
    expect(components.filter((f) => !isSourceFile(f, SOURCE_GLOBS))).toEqual([]);
  });

  it("are the ones the coverage run uses", () => {
    expect(vitestConfig.test?.coverage).toMatchObject({
      include: SOURCE_GLOBS.include,
      exclude: SOURCE_GLOBS.exclude,
    });
  });

  it("leave out spikes", () => {
    const spikes = list("spikes/*/**/*.ts").filter((f) => !f.includes("node_modules"));
    expect(spikes.length).toBeGreaterThan(0);
    expect(spikes.filter((f) => isSourceFile(f, SOURCE_GLOBS))).toEqual([]);
  });
});

describe("checkChanged", () => {
  it("reports uncovered lines for files with coverage, and unexplained hints for source files", () => {
    // A file without coverage comes first, so the files after it must still be checked.
    const added = new Map([
      ["docs/note.md", [{ line: 2, text: "/* v8 ignore next */" }]],
      [
        "src/a.ts",
        [
          { line: 1, text: "ok();" },
          { line: 2, text: "never();" },
          { line: 3, text: "/* v8 ignore next */" },
        ],
      ],
      // Source, but absent from the coverage JSON (as an `ignore file` hint leaves it).
      ["src/b.ts", [{ line: 1, text: "/* v8 ignore file */" }]],
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
    expect(checkChanged(added, coverage, TEST_GLOBS)).toEqual({
      uncovered: [{ file: "src/a.ts", line: 2 }],
      unexplained: [
        { file: "src/a.ts", line: 3 },
        { file: "src/b.ts", line: 1 },
      ],
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
    expect(parseCliArgs(["--base=abc"])).toEqual({ base: "abc" });
  });

  it("names the bad argument in the usage error", () => {
    expect(() => parseCliArgs(["--bse", "x"])).toThrow(/usage: coverage-changed .*'--bse'/);
  });

  it.each([[["--bse", "x"]], [["--base"]], [["--coverage", "--base"]], [["stray"]]])("rejects %j", (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(/usage: coverage-changed/);
    // The parser's own error stays attached as the cause.
    expect(() => parseCliArgs(argv)).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ code: expect.stringMatching(/^ERR_PARSE_ARGS_/) }),
      }),
    );
  });
});

describe("baseRef", () => {
  it("takes --base (an empty one too), else a non-empty environment value, else origin/main", () => {
    expect(baseRef("flag", "env")).toBe("flag");
    expect(baseRef("", "env")).toBe("");
    expect(baseRef(undefined, "env")).toBe("env");
    expect(baseRef(undefined, "")).toBe("origin/main");
    expect(baseRef(undefined, undefined)).toBe("origin/main");
  });
});

describe("namesSince", () => {
  let repo: TestRepo;

  // The feature branch deletes a/gone.txt and adds a non-ASCII a/café.txt and b/new.txt; main then changes
  // b/out.txt, which a two-dot diff would list and the merge-base (three-dot) diff doesn't.
  beforeEach(() => {
    repo = gitRepo("names-since-");
    repo.write("a/gone.txt", "gone\n");
    repo.write("b/out.txt", "out\n");
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feature");
    repo.git("rm", "-q", "a/gone.txt");
    repo.write("a/café.txt", "café\n");
    repo.write("b/new.txt", "new\n");
    repo.commit("feature");
    repo.git("checkout", "-q", "main");
    repo.write("b/out.txt", "changed on main\n");
    repo.commit("main moves on");
    repo.git("checkout", "-q", "feature");
  });
  afterEach(() => repo.remove());

  it("lists the names the filter selects since the merge base, unquoted, with no empty entry", () => {
    expect(namesSince(repo.git, "main", "--diff-filter=d")).toEqual(["a/café.txt", "b/new.txt"]);
    expect(namesSince(repo.git, "main", "--diff-filter=D")).toEqual(["a/gone.txt"]);
  });

  it("limits the names to the given paths", () => {
    expect(namesSince(repo.git, "main", "--diff-filter=d", ["b/"])).toEqual(["b/new.txt"]);
  });

  it("reads a path limit as a path, so one missing from the working tree lists nothing", () => {
    expect(namesSince(repo.git, "main", "--diff-filter=d", ["c/"])).toEqual([]);
  });

  it("throws when git can't diff against the base", () => {
    expect(() => namesSince(repo.git, "nope", "--diff-filter=d")).toThrow();
  });
});

describe("main", () => {
  let repo: string;
  let git: TestRepo["git"];
  let write: TestRepo["write"];
  let commit: TestRepo["commit"];
  let remove: TestRepo["remove"];
  let out: string[];
  let errors: string[];
  /** Writes coverage JSON keyed by absolute path, as Vitest does. */
  const writeCoverage = (files: Record<string, FileCoverage>, path = "coverage/coverage-final.json") =>
    write(
      path,
      JSON.stringify(Object.fromEntries(Object.entries(files).map(([f, c]) => [join(repo, f), c]))),
    );
  const run = (argv: string[] = ["--base", "main"], vars: Record<string, string | undefined> = {}) =>
    main(argv, vars, {
      cwd: repo,
      log: (l) => out.push(l),
      logError: (l) => errors.push(l),
      sources: TEST_GLOBS,
    });

  // src/a.ts on main: lines 1-3. The branch then adds line 4 (and edits below per test).
  // src/old.ts: five kept lines and one the branch edits, so git sees a rename with an edit.
  const KEPT = [1, 2, 3, 4, 5].map((n) => `export const kept${n} = ${n};\n`).join("");
  const BASE = "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n";

  beforeEach(() => {
    ({ dir: repo, git, write, commit, remove } = gitRepo("coverage-changed-"));
    // A user's config can colour diffs, route them through an external tool, or turn rename detection off;
    // the gate must not depend on any of it.
    git("config", "color.diff", "always");
    git("config", "diff.external", "false");
    git("config", "diff.renames", "false");
    write(".gitignore", "coverage/\n");
    write("src/a.ts", BASE);
    write("src/old.ts", `${KEPT}export const edited = 1;\n`);
    commit("base");
    git("checkout", "-q", "-b", "feature");
    out = [];
    errors = [];
  });

  afterEach(() => {
    remove();
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

  it("reads a diff longer than execFileSync's default 1 MB buffer", () => {
    // A 2 MB file the gate ignores (not source) still goes through `git diff`, which used to end in ENOBUFS.
    write("results/big.txt", `${"x".repeat(99)}\n`.repeat(20_000));
    write("src/a.ts", `${BASE}export const four = 4;\n`);
    commit("add four and a large file");
    writeCoverage({ "src/a.ts": fileCoverage([[1, 4, 1]]) });
    expect(run()).toBe(0);
    expect(out).toEqual(["coverage-changed: every added source line since main ran in a test."]);
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

  it("fails a hint with no reason in a source file the coverage JSON leaves out (`ignore file`)", () => {
    write("src/b.ts", "/* v8 ignore file */\nexport const b = never();\n");
    commit("add b");
    writeCoverage({ "src/a.ts": fileCoverage([[1, 3, 1]]) });
    expect(run()).toBe(1);
    expect(out).toEqual(['Coverage ignore hints without a reason after "--" (1):', "src/b.ts:1"]);
  });

  it("without `sources`, takes source files from the coverage globs (scripts/*.ts is one)", () => {
    write("scripts/b.ts", "/* v8 ignore next */\nexport const b = never();\n");
    commit("add b");
    writeCoverage({ "src/a.ts": fileCoverage([[1, 3, 1]]) });
    const code = main(
      ["--base", "main"],
      {},
      { cwd: repo, log: (l) => out.push(l), logError: (l) => errors.push(l) },
    );
    expect(code).toBe(1);
    expect(out).toEqual(['Coverage ignore hints without a reason after "--" (1):', "scripts/b.ts:1"]);
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
    write("scripts/deploy.sh", "echo never # v8 ignore start\n");
    write("docs/note.md", "/* v8 ignore next */\n");
    write("src/style.css", "a { color: red; } /* v8 ignore next */\n");
    write("src/a.test.ts", "/* v8 ignore next */\nnever();\n");
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

  it("diffs from the merge base, so what the base changed since the branch began doesn't count", () => {
    git("checkout", "-q", "main");
    write("src/old.ts", `${KEPT.split("\n").slice(1).join("\n")}export const edited = 1;\n`);
    commit("main drops kept1");
    git("checkout", "-q", "feature");
    write("src/a.ts", `${BASE}export const four = 4;\n`);
    commit("add four");
    // On the branch, src/old.ts line 1 (kept1, which main has since dropped) never ran.
    writeCoverage({ "src/a.ts": fileCoverage([[1, 4, 1]]), "src/old.ts": fileCoverage([[1, 1, 0]]) });
    expect(run()).toBe(0);
  });

  it("reads paths with non-ASCII characters as git wrote them", () => {
    write("src/café.ts", "export const crème = never();\n");
    commit("add café");
    writeCoverage({ "src/café.ts": fileCoverage([[1, 1, 0]]) });
    expect(run()).toBe(1);
    expect(out).toContain("src/café.ts:1");
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
    // The branch adds uncovered line 4, so a run against `main` fails. `origin/main` points at the branch
    // head here, so a run against it has nothing to check and passes.
    beforeEach(() => {
      write("src/a.ts", `${BASE}export const four = never();\n`);
      commit("feature adds four");
      writeCoverage({ "src/a.ts": fileCoverage([[4, 4, 0]]) });
      git("update-ref", "refs/remotes/origin/main", "HEAD");
    });

    it("defaults to origin/main", () => {
      expect(run([])).toBe(0);
      expect(out).toEqual(["coverage-changed: every added source line since origin/main ran in a test."]);
    });

    it("uses COVERAGE_BASE, and --base over it", () => {
      expect(run([], { COVERAGE_BASE: "main" })).toBe(1);
      expect(out).toContain("src/a.ts:4");
      expect(run(["--base", "origin/main"], { COVERAGE_BASE: "main" })).toBe(0);
    });

    it("treats an empty COVERAGE_BASE (a push run) as unset", () => {
      expect(run([], { COVERAGE_BASE: "" })).toBe(0);
      expect(out.at(-1)).toMatch(/since origin\/main ran/);
    });

    it("without a merge base: exits 2 in CI, and warns and passes locally", () => {
      expect(run(["--base", "no-such-ref"], { CI: "true" })).toBe(2);
      expect(errors.at(-1)).toMatch(/no merge base with no-such-ref \(CI must fetch the full history\)/);
      expect(run(["--base", "no-such-ref"], {})).toBe(0);
      expect(errors.at(-1)).toMatch(/SKIPPING: no merge base with no-such-ref/);
    });
  });

  it("sets the process exit code from main when run as a script", () => {
    write("src/a.ts", `${BASE}export const four = never();\n`);
    commit("add four");
    writeCoverage({ "src/a.ts": fileCoverage([[4, 4, 0]]) });
    const script = join(import.meta.dirname, "coverage-changed.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        script,
        "--base",
        "main",
        "--coverage",
        "coverage/coverage-final.json",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    // The default source globs don't cover the throwaway repo's src/, so only the uncovered line counts.
    expect(result.stdout).toContain("src/a.ts:4");
    expect(result.status).toBe(1);
  });

  it("logs to the console by default", async () => {
    await withConsole((log, error) => {
      expect(main(["--base", "main"], {}, { cwd: repo })).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/run `npm run test:coverage` first/));
      writeCoverage({});
      expect(main(["--base", "main"], {}, { cwd: repo })).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/every added source line since main/));
      // No deps at all: git runs in the process's directory, which still parses the arguments first.
      expect(main(["--nope"], {})).toBe(2);
      expect(error).toHaveBeenLastCalledWith(expect.stringMatching(/usage: coverage-changed/));
    });
  });
});
