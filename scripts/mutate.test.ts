/**
 * scripts/mutate.ts against a throwaway directory: a target file, a small Node checker standing in for a test
 * command (it fails when the file says "bad", hangs when it says "slow"), and a stand-in `vitest` that writes a
 * Vitest JSON report. Most tests call `main` in-process, because a child process records no coverage; three
 * spawn the script, for its exit code and for the file it restores on SIGINT and SIGTERM.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkExpected,
  classify,
  codeSpan,
  DEFAULT_TIMEOUT_SECONDS,
  type EditResult,
  failedTestNames,
  formatResult,
  isVitest,
  main,
  MARKDOWN_HEADER,
  markdownTable,
  occurrences,
  parseCliArgs,
  runCommand,
  stopRunning,
} from "./mutate";
import { logsTo, withConsole } from "./test/git-repo";

const TARGET = "const ok = true;\nexport const value = ok ? 1 : 2;\n";

// Appends a word to ran.log beside itself each time it starts (whatever its working directory), so a test can tell
// whether it ran at all. Exits 1 (saying so on stderr) when target.txt says "bad" or holds a "$", exits 0 otherwise.
// When it says "slow" it writes its pid to checker.pid and hangs, but for 30 s at most (far beyond any test's wait), then exits
// 1: a checker a broken kill path leaves behind still ends, and never looks like a passing run.
const CHECKER = `
const fs = require("node:fs");
fs.appendFileSync(require("node:path").join(__dirname, "ran.log"), "ran ");
const text = fs.readFileSync("target.txt", "utf8");
if (text.includes("slow")) {
  fs.writeFileSync("checker.pid", String(process.pid));
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(1), 30_000);
} else if (text.includes("bad") || text.includes("$")) {
  console.error("checker: bad");
  process.exit(1);
}
`;

// A stand-in for Vitest: with --reporter=json, writes a JSON report to --outputFile.json=<path> naming a failed
// test when target.txt says "bad"; crashes without a report when it says "crash", printing 2,500 characters of
// filler, then the reporter flags it was given, then why; else passes.
const FAKE_VITEST = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv.find((a) => a.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
const text = fs.readFileSync("target.txt", "utf8");
if (text.includes("crash")) {
  console.log("x".repeat(2500));
  console.log("reporters: " + process.argv.filter((a) => a.startsWith("--reporter=")).join(" "));
  console.log("fake vitest crashed");
  process.exit(1);
}
const bad = text.includes("bad");
if (process.argv.includes("--reporter=json")) fs.writeFileSync(out, JSON.stringify({ testResults: [{
  name: path.join(process.cwd(), "target.test.ts"),
  assertionResults: [
    { status: "passed", fullName: "suite keeps the rest" },
    { status: bad ? "failed" : "passed", fullName: "suite rejects bad" },
  ],
}] }));
process.exit(bad ? 1 : 0);
`;

let dir: string;
let out: string[];
let errors: string[];
const deps = () => ({ cwd: dir, ...logsTo(out, errors) });
const checker = () => ["node", join(dir, "checker.cjs")];
const vitest = () => [join(dir, "vitest"), "run"];
// The checker under sh, which stays its parent (the "; true" keeps sh from exec'ing node): killing only the process
// the runner started would leave the checker running, so only a kill of the whole process group stops it.
const checkerUnderSh = () => ["sh", "-c", `node ${join(dir, "checker.cjs")}; true`];
const target = () => readFileSync(join(dir, "target.txt"), "utf8");
/** True while the process with this pid runs. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ran = () => existsSync(join(dir, "ran.log"));
const checkerPid = () => Number(readFileSync(join(dir, "checker.pid"), "utf8"));
const editsFile = (edits: unknown[]) => {
  writeFileSync(join(dir, "edits.json"), JSON.stringify(edits));
  return "edits.json";
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mutate-test-")));
  writeFileSync(join(dir, "target.txt"), TARGET);
  writeFileSync(join(dir, "checker.cjs"), CHECKER);
  writeFileSync(join(dir, "vitest"), FAKE_VITEST);
  chmodSync(join(dir, "vitest"), 0o755);
  out = [];
  errors = [];
});
afterEach(() => {
  // A checker still running here was left behind by the code under test: stop it, and fail the test.
  const pidFile = join(dir, "checker.pid");
  const left = existsSync(pidFile) && alive(checkerPid());
  if (left) process.kill(checkerPid(), "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  expect(left, "a checker process was left running").toBe(false);
});

describe("occurrences", () => {
  it.each([
    ["abc", "x", 0],
    ["abc", "b", 1],
    ["abab", "ab", 2],
    ["aaa", "aa", 1],
    ["abc", "", 0],
  ])("%j has %j %i times", (text, find, n) => {
    expect(occurrences(text, find)).toBe(n);
  });
});

describe("isVitest", () => {
  it.each([
    [["npx", "vitest", "run"], true],
    [["node_modules/.bin/vitest"], true],
    [["node", "node_modules/vitest/vitest.mjs"], true],
    [["npx", "vitest-runner"], false],
    [["node", "myvitest"], false],
    [["npm", "test"], false],
  ])("%j → %s", (cmd, expected) => {
    expect(isVitest(cmd)).toBe(expected);
  });
});

describe("failedTestNames", () => {
  it("names each failed test as its file relative to cwd and its full name, and skips the rest", () => {
    const report = {
      testResults: [
        {
          name: "/repo/a/x.test.ts",
          assertionResults: [
            { status: "failed", fullName: "x one" },
            { status: "passed", fullName: "x two" },
            { status: "skipped", fullName: "x three" },
          ],
        },
        { name: "/elsewhere/y.test.ts", assertionResults: [{ status: "failed", fullName: "y" }] },
        { name: "/repo/z.test.ts" },
      ],
    };
    expect(failedTestNames(report, "/repo")).toEqual(["a/x.test.ts > x one", "/elsewhere/y.test.ts > y"]);
  });

  it("strips the cwd only as a whole directory", () => {
    const report = {
      testResults: [{ name: "/repo2/x.test.ts", assertionResults: [{ status: "failed", fullName: "x" }] }],
    };
    expect(failedTestNames(report, "/repo")).toEqual(["/repo2/x.test.ts > x"]);
  });

  it("is empty for a report without test results", () => {
    expect(failedTestNames({}, "/repo")).toEqual([]);
  });
});

describe("classify", () => {
  it.each([
    [{ code: null, timedOut: true, failedTests: undefined }, "TIMEOUT"],
    [{ code: 1, timedOut: true, failedTests: ["t"] }, "TIMEOUT"],
    [{ code: 0, timedOut: false, failedTests: undefined }, "SURVIVED"],
    [{ code: 0, timedOut: false, failedTests: [] }, "SURVIVED"],
    [{ code: 1, timedOut: false, failedTests: undefined }, "KILLED"],
    [{ code: 1, timedOut: false, failedTests: ["t"] }, "KILLED"],
    [{ code: 1, timedOut: false, failedTests: [] }, "ERROR"],
  ] as const)("%j → %s", (outcome, status) => {
    expect(classify({ ...outcome, failedTests: outcome.failedTests && [...outcome.failedTests] })).toBe(
      status,
    );
  });
});

describe("checkExpected", () => {
  it.each([
    ["KILLED", ["a.test.ts > rejects bad"], ["rejects bad"], "KILLED"],
    ["KILLED", ["a.test.ts > one", "a.test.ts > rejects bad"], ["nothing", "rejects"], "KILLED"],
    ["KILLED", ["a.test.ts > one"], ["rejects bad"], "KILLED-OTHER"],
    ["KILLED", [], ["rejects bad"], "KILLED-OTHER"],
    ["KILLED", ["a.test.ts > one"], undefined, "KILLED"],
    ["KILLED", ["a.test.ts > one"], [], "KILLED"],
    ["SURVIVED", [], ["rejects bad"], "SURVIVED"],
    ["ERROR", [], ["rejects bad"], "ERROR"],
  ] as const)("%s with failed %j and expect %j → %s", (status, failed, expected, result) => {
    expect(checkExpected(status, failed, expected)).toBe(result);
  });
});

describe("parseCliArgs", () => {
  it("takes an option's value after =", () => {
    expect(parseCliArgs(["e.json", "--timeout=7", "--only=a", "--", "npm"])).toMatchObject({
      timeout: 7,
      only: ["a"],
    });
  });

  it("reads the edits file, the options and the command after --", () => {
    expect(
      parseCliArgs([
        "e.json",
        "--timeout",
        "7",
        "--json",
        "o.json",
        "--only",
        "a,b",
        "--",
        "npx",
        "vitest",
        "--",
        "x",
      ]),
    ).toEqual({
      editsFile: "e.json",
      timeout: 7,
      json: "o.json",
      only: ["a", "b"],
      markdown: false,
      cmd: ["npx", "vitest", "--", "x"],
    });
  });

  it("defaults the timeout", () => {
    expect(parseCliArgs(["e.json", "--", "npm", "test"])).toEqual({
      editsFile: "e.json",
      timeout: DEFAULT_TIMEOUT_SECONDS,
      markdown: false,
      cmd: ["npm", "test"],
    });
    expect(parseCliArgs(["e.json", "--markdown", "--", "npm"]).markdown).toBe(true);
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(300);
  });

  it.each([
    [["e.json"], "usage:"],
    [["e.json", "--"], "usage:"],
    [["--", "npm", "test"], "no edits file"],
    [["e.json", "--timeout", "--", "npm"], "Option '--timeout <value>' argument missing"],
    [["e.json", "--json", "--", "npm"], "Option '--json <value>' argument missing"],
    [["e.json", "--only", "--", "npm"], "Option '--only <value>' argument missing"],
    [["e.json", "--only"], "usage:"],
    [["e.json", "--bogus", "--", "npm"], "Unknown option '--bogus'"],
    [["e.json", "f.json", "--", "npm"], "unexpected argument f.json"],
    [["e.json", "--timeout", "0", "--", "npm"], "--timeout must be"],
    [["e.json", "--timeout", "x", "--", "npm"], "--timeout must be"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
    expect(() => parseCliArgs(argv)).toThrow("usage: mutate");
  });
});

describe("formatResult", () => {
  const result: EditResult = {
    id: "7",
    file: "a.ts",
    find: "x\ny",
    replace: "z",
    status: "KILLED",
    failedTests: ["a.test.ts > one", "a.test.ts > two"],
    seconds: 1,
  };

  it("prints the status, id, file and both sides of the edit, newlines as ⏎, then each failed test", () => {
    expect(formatResult(result)).toEqual([
      "KILLED 7 a.ts: x⏎y → z",
      "    ✗ a.test.ts > one",
      "    ✗ a.test.ts > two",
    ]);
  });

  it("prints no detail line for an error, whose detail is the command's output", () => {
    expect(formatResult({ ...result, status: "ERROR", failedTests: [], detail: "output" })).toEqual([
      "ERROR 7 a.ts: x⏎y → z",
    ]);
  });

  it("names what a KILLED-OTHER edit expected, and an empty list when it has none", () => {
    const other = { ...result, status: "KILLED-OTHER" as const, failedTests: [] };
    expect(formatResult({ ...other, expect: ["one", "two"] })).toEqual([
      "KILLED-OTHER 7 a.ts: x⏎y → z",
      "    (expected: one, two)",
    ]);
    expect(formatResult(other)).toEqual(["KILLED-OTHER 7 a.ts: x⏎y → z", "    (expected: )"]);
  });

  it("says why an edit was refused", () => {
    expect(
      formatResult({ ...result, status: "REFUSED", failedTests: [], detail: "find occurs 2 times" }),
    ).toEqual(["REFUSED 7 a.ts: x⏎y → z", "    (find occurs 2 times)"]);
  });
});

describe("codeSpan", () => {
  it.each([
    ["a ? 1", "`a ? 1`"],
    ["a\nb", "`a⏎b`"],
    ["a || b", "`a \\|\\| b`"],
    ["x `y` z", "``x `y` z``"],
    ["`y``", "``` `y`` ```"],
    ["`y", "`` `y ``"],
    ["y`", "`` y` ``"],
    ["", "``"],
  ])("%j → %s", (text, span) => {
    expect(codeSpan(text)).toBe(span);
  });
});

describe("markdownTable", () => {
  const base = { file: "a.ts", find: "x", replace: "y", seconds: 1 };
  it("has one row per result, with the edit, the status (and why), the failed tests, then the summary", () => {
    const results: EditResult[] = [
      {
        ...base,
        id: "k",
        status: "KILLED",
        expect: ["one"],
        failedTests: ["a.test.ts > one", "a.test.ts > two"],
      },
      {
        ...base,
        id: "o|1",
        status: "KILLED-OTHER",
        expect: ["three", "four"],
        failedTests: ["b.test.ts > b"],
      },
      { ...base, id: "k2", status: "KILLED", failedTests: ["a.test.ts > three"] },
      { ...base, id: "k3", status: "KILLED", expect: [], failedTests: ["a.test.ts > three"] },
      { ...base, id: "s", status: "SURVIVED", failedTests: [] },
      { ...base, id: "r", status: "REFUSED", failedTests: [], detail: "find occurs 2 times" },
    ];
    expect(markdownTable(results)).toEqual([
      MARKDOWN_HEADER,
      "|---|---|---|---|---|",
      "| k | `a.ts` | `x` → `y` | KILLED | `a.test.ts > one`<br>`a.test.ts > two` |",
      "| o\\|1 | `a.ts` | `x` → `y` | KILLED-OTHER (expected: three, four) | `b.test.ts > b` |",
      "| k2 | `a.ts` | `x` → `y` | KILLED (no expect) | `a.test.ts > three` |",
      "| k3 | `a.ts` | `x` → `y` | KILLED (no expect) | `a.test.ts > three` |",
      "| s | `a.ts` | `x` → `y` | SURVIVED | — |",
      "| r | `a.ts` | `x` → `y` | REFUSED (find occurs 2 times) | — |",
      "",
      "6 edits: 3 killed, 1 killed other tests, 1 survived, 0 timed out, 0 errors, 1 refused",
    ]);
    expect(MARKDOWN_HEADER).toBe("| Edit | File | Change | Status | Failed tests |");
  });
});

describe("main", () => {
  it("reads an edit as KILLED only when a test its expect list names went red, and exits 1 otherwise", async () => {
    const edits = editsFile([
      { id: "k", file: "target.txt", find: "ok ? 1", replace: "bad ? 1", expect: ["rejects bad"] },
      { id: "o", file: "target.txt", find: "ok ? 1", replace: "bad ? 1", expect: ["keeps the rest"] },
    ]);
    const code = await main([edits, "--json", "out.json", "--", ...vitest()], deps());
    expect(out.slice(0, 5)).toEqual([
      "KILLED k target.txt: ok ? 1 → bad ? 1",
      "    ✗ target.test.ts > suite rejects bad",
      "KILLED-OTHER o target.txt: ok ? 1 → bad ? 1",
      "    ✗ target.test.ts > suite rejects bad",
      "    (expected: keeps the rest)",
    ]);
    expect(out.at(-1)).toContain("2 edits: 1 killed, 1 killed other tests, 0 survived");
    expect(code).toBe(1);
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: EditResult[] };
    expect(results.map((r) => r.expect)).toEqual([["rejects bad"], ["keeps the rest"]]);
  });

  it("reads a killed edit with an expect list as KILLED-OTHER when the command names no tests", async () => {
    const edits = editsFile([
      { id: "o", file: "target.txt", find: "ok ? 1", replace: "bad ? 1", expect: ["x"] },
    ]);
    expect(await main([edits, "--", ...checker()], deps())).toBe(1);
    expect(out[0]).toBe("KILLED-OTHER o target.txt: ok ? 1 → bad ? 1");
  });

  it("with --markdown, prints the progress to stderr and only the table and summary to stdout", async () => {
    const edits = editsFile([
      { id: "k", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" },
      { id: "s", file: "target.txt", find: "const ok", replace: "const fine" },
    ]);
    const code = await main([edits, "--markdown", "--", ...vitest()], deps());
    expect(out).toEqual([
      MARKDOWN_HEADER,
      "|---|---|---|---|---|",
      "| k | `target.txt` | `ok ? 1` → `bad ? 1` | KILLED (no expect) | `target.test.ts > suite rejects bad` |",
      "| s | `target.txt` | `const ok` → `const fine` | SURVIVED | — |",
      "",
      "2 edits: 1 killed, 0 killed other tests, 1 survived, 0 timed out, 0 errors, 0 refused",
    ]);
    expect(errors).toEqual([
      "KILLED k target.txt: ok ? 1 → bad ? 1",
      "    ✗ target.test.ts > suite rejects bad",
      "SURVIVED s target.txt: const ok → const fine",
    ]);
    expect(code).toBe(1);
  });

  it("applies each edit alone, restores the file after each, and reports KILLED and SURVIVED", async () => {
    const edits = editsFile([
      { id: "k", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" },
      { file: "target.txt", find: "const ok", replace: "const fine" },
    ]);
    const code = await main([edits, "--", ...checker()], deps());
    expect(out.slice(0, 2)).toEqual([
      "KILLED k target.txt: ok ? 1 → bad ? 1",
      "SURVIVED 2 target.txt: const ok → const fine",
    ]);
    expect(out.at(-1)).toBe(
      "\n2 edits: 1 killed, 0 killed other tests, 1 survived, 0 timed out, 0 errors, 0 refused",
    );
    expect(code).toBe(1);
    expect(target()).toBe(TARGET);
  });

  it("exits 0 when every edit was killed or timed out", async () => {
    const edits = editsFile([
      { id: "k", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" },
      { id: "t", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" },
    ]);
    const code = await main([edits, "--timeout", "1", "--", ...checker()], deps());
    expect(out.slice(0, 2)).toEqual([
      "KILLED k target.txt: ok ? 1 → bad ? 1",
      "TIMEOUT t target.txt: ok ? 1 → slow ? 1",
    ]);
    expect(out.at(-1)).toBe(
      "\n2 edits: 1 killed, 0 killed other tests, 0 survived, 1 timed out, 0 errors, 0 refused",
    );
    expect(code).toBe(0);
    expect(target()).toBe(TARGET);
  });

  it("kills a timed-out command's whole process group, not only the process it started", async () => {
    // Killing sh alone would leave the checker running and holding the output pipe open.
    const edits = editsFile([{ id: "t", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" }]);
    const code = await main([edits, "--timeout", "1", "--", ...checkerUnderSh()], deps());
    expect(out[0]).toBe("TIMEOUT t target.txt: ok ? 1 → slow ? 1");
    expect(code).toBe(0);
    await vi.waitFor(() => expect(alive(checkerPid())).toBe(false), { timeout: 2_000, interval: 50 });
  }, 10_000);

  it("removes its report directory after each run", async () => {
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    vi.stubEnv("TMPDIR", tmp);
    try {
      const edits = editsFile([{ id: "k", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" }]);
      await main([edits, "--", ...vitest()], deps());
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records how long each run took, and 0 s for a refused edit", async () => {
    const edits = editsFile([
      { id: "t", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" },
      { id: "r", file: "target.txt", find: "missing", replace: "x" },
    ]);
    await main([edits, "--timeout", "1", "--json", "out.json", "--", ...checker()], deps());
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: EditResult[] };
    expect(results[0]?.seconds).toBeGreaterThanOrEqual(1);
    expect(results[0]?.seconds).toBeLessThan(5);
    expect(results[1]?.seconds).toBe(0);
  });

  it("refuses an edit whose find occurs other than once, and exits 2", async () => {
    const edits = editsFile([
      { id: "none", file: "target.txt", find: "missing", replace: "bad" },
      { id: "two", file: "target.txt", find: "ok", replace: "bad" },
    ]);
    const code = await main([edits, "--", ...checker()], deps());
    expect(out.slice(0, 4)).toEqual([
      "REFUSED none target.txt: missing → bad",
      "    (find occurs 0 times)",
      "REFUSED two target.txt: ok → bad",
      "    (find occurs 2 times)",
    ]);
    expect(code).toBe(2);
    expect(target()).toBe(TARGET);
  });

  it("writes replace as it stands, $ patterns included", async () => {
    // Through String.replace's pattern rules "$&" would put the match back, leaving the file unchanged and the
    // edit SURVIVED; written as it stands, the checker sees the "$" and fails.
    const edits = editsFile([{ id: "d", file: "target.txt", find: "const ok", replace: "$&" }]);
    const code = await main([edits, "--", ...checker()], deps());
    expect(out[0]).toBe("KILLED d target.txt: const ok → $&");
    expect(code).toBe(0);
  });

  it("names the failed tests of a Vitest run, and calls a failing Vitest run with no failed test an ERROR", async () => {
    const edits = editsFile([
      { id: "k", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" },
      { id: "e", file: "target.txt", find: "ok ? 1", replace: "crash ? 1" },
    ]);
    const code = await main([edits, "--json", "out.json", "--", ...vitest()], deps());
    expect(out.slice(0, 3)).toEqual([
      "KILLED k target.txt: ok ? 1 → bad ? 1",
      "    ✗ target.test.ts > suite rejects bad",
      "ERROR e target.txt: ok ? 1 → crash ? 1",
    ]);
    expect(code).toBe(2);
    const written = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as {
      cmd: string[];
      results: EditResult[];
    };
    expect(written.cmd).toEqual([...vitest()]);
    expect(written.results.map((r) => [r.id, r.status, r.failedTests])).toEqual([
      ["k", "KILLED", ["target.test.ts > suite rejects bad"]],
      ["e", "ERROR", []],
    ]);
    expect(written.results[0]?.detail).toBeUndefined();
  });

  it("adds the dot and JSON reporters to Vitest, and keeps the last 2,000 characters of an errored run's output", async () => {
    const edits = editsFile([{ id: "e", file: "target.txt", find: "ok ? 1", replace: "crash ? 1" }]);
    await main([edits, "--json", "out.json", "--", ...vitest()], deps());
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: EditResult[] };
    const detail = results[0]?.detail ?? "";
    expect(detail).toHaveLength(2000);
    expect(detail).toContain(`reporters: --reporter=dot --reporter=json\nfake vitest crashed\n`);
    expect(detail.endsWith("fake vitest crashed\n")).toBe(true);
  });

  it("exits 1 when an edit survived, even beside a refused edit", async () => {
    const edits = editsFile([
      { id: "s", file: "target.txt", find: "const ok", replace: "const fine" },
      { id: "r", file: "target.txt", find: "missing", replace: "x" },
    ]);
    expect(await main([edits, "--", ...checker()], deps())).toBe(1);
  });

  it("refuses an edit whose file can't be read, saying why", async () => {
    const edits = editsFile([{ id: "m", file: "missing.txt", find: "a", replace: "b" }]);
    const code = await main([edits, "--", ...checker()], deps());
    expect(out[0]).toBe("REFUSED m missing.txt: a → b");
    expect(out[1]).toMatch(/^ {4}\(can't read the file: ENOENT/);
    expect(code).toBe(2);
    expect(existsSync(join(dir, "missing.txt"))).toBe(false);
  });

  it.each([
    ["a missing file", undefined, "can't read the edits file"],
    ["a file that isn't JSON", "[{", "can't read the edits file"],
    ["JSON that isn't a list", "{}", "isn't a list of edits"],
    ["a null entry", "[null]", "edit 1 in"],
    ["an entry with no file", '[{"find":"ok ? 1","replace":"bad"}]', "edit 1 in"],
    ["an entry with no find", '[{"file":"target.txt","replace":"bad"}]', "edit 1 in"],
    ["an entry with no replace", '[{"file":"target.txt","find":"ok ? 1"}]', "edit 1 in"],
    ["a numeric id", '[{"id":1,"file":"target.txt","find":"ok ? 1","replace":"bad"}]', "edit 1 in"],
    [
      "an expect that isn't a list",
      '[{"file":"target.txt","find":"ok ? 1","replace":"bad","expect":"t"}]',
      "edit 1 in",
    ],
    [
      "an expect with a number",
      '[{"file":"target.txt","find":"ok ? 1","replace":"bad","expect":[1]}]',
      "edit 1 in",
    ],
  ])("exits 2 for %s, running and writing nothing", async (_, content, message) => {
    if (content !== undefined) writeFileSync(join(dir, "edits.json"), content);
    const code = await main(["edits.json", "--", ...checker()], deps());
    expect(code).toBe(2);
    expect(errors[0]).toContain(message);
    expect(out).toEqual([]);
    expect(ran()).toBe(false);
    expect(target()).toBe(TARGET);
  });

  it("exits 2 naming an --only id that no edit has, before running anything", async () => {
    const edits = editsFile([
      { id: "a", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" },
      { id: "b", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" },
    ]);
    const code = await main([edits, "--only", "a,zz", "--", ...checker()], deps());
    expect(code).toBe(2);
    expect(errors).toEqual(["mutate: --only names no edit with the id zz"]);
    expect(out).toEqual([]);
    expect(ran()).toBe(false);
  });

  it("exits 2 when the command can't be started", async () => {
    editsFile([{ id: "a", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" }]);
    const code = await main(["edits.json", "--", join(dir, "no-such-command")], deps());
    expect(code).toBe(2);
    expect(errors[0]).toContain("the unedited run failed (exit null)");
    expect(errors[0]).toContain("ENOENT");
  });

  it("runs only the edits --only names", async () => {
    const edits = editsFile([
      { id: "a", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" },
      { id: "b", file: "target.txt", find: "const ok", replace: "const fine" },
    ]);
    const code = await main([edits, "--only", "a", "--", ...checker()], deps());
    expect(out[0]).toBe("KILLED a target.txt: ok ? 1 → bad ? 1");
    expect(out.at(-1)).toContain("1 edits: 1 killed");
    expect(code).toBe(0);
  });

  it("mutates nothing when the unedited run fails", async () => {
    writeFileSync(join(dir, "target.txt"), "bad\n");
    const edits = editsFile([{ id: "a", file: "target.txt", find: "bad", replace: "fine" }]);
    const code = await main([edits, "--", ...checker()], deps());
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(errors[0]).toContain("the unedited run failed (exit 1); nothing was mutated");
    expect(errors[0]).toContain("checker: bad");
  });

  it("reports wrong arguments with the usage and exits 2", async () => {
    expect(await main(["edits.json"], deps())).toBe(2);
    expect(errors[0]).toContain("usage: mutate");
  });

  it("logs to the console by default, relative to the process's directory", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      await withConsole(async (log, error) => {
        editsFile([{ id: "a", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" }]);
        expect(await main(["edits.json", "--", ...checker()])).toBe(0);
        expect(log).toHaveBeenCalledWith("KILLED a target.txt: ok ? 1 → bad ? 1");
        expect(await main(["edits.json"])).toBe(2);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: mutate"));
      });
    } finally {
      cwd.mockRestore();
    }
  });

  it("stops a running command's process group and removes its report directory when asked", async () => {
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    vi.stubEnv("TMPDIR", tmp);
    try {
      const edits = editsFile([{ id: "t", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" }]);
      const done = main([edits, "--", ...checkerUnderSh()], deps());
      await vi.waitFor(() => expect(existsSync(join(dir, "checker.pid"))).toBe(true), {
        timeout: 5_000,
        interval: 20,
      });
      expect(readdirSync(tmp)).toHaveLength(1);
      stopRunning();
      expect(readdirSync(tmp)).toEqual([]);
      await done;
      // Killed by a signal, the command exits non-zero, so the edit reads as KILLED; the file is restored.
      expect(out[0]).toBe("KILLED t target.txt: ok ? 1 → slow ? 1");
      // sh can close before the killed checker is gone (not yet torn down, or not yet reaped), so wait for it.
      await vi.waitFor(() => expect(alive(checkerPid())).toBe(false), { timeout: 2_000, interval: 20 });
      expect(target()).toBe(TARGET);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forgets the command once it ends, so a later signal kills no process group and removes nothing", async () => {
    editsFile([{ id: "a", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" }]);
    await main(["edits.json", "--", ...checker()], deps());
    const kill = vi.spyOn(process, "kill");
    try {
      stopRunning();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("reads a command that can't be started as ERROR, and holds no process group for it", async () => {
    const started = runCommand([join(dir, "no-such-command")], 5, dir);
    // Before the spawn error arrives: a signal now must not try to kill a process group with no pid.
    expect(() => stopRunning()).not.toThrow();
    const outcome = await started;
    expect(outcome.output).toContain("ENOENT");
    expect(classify(outcome)).toBe("ERROR");
  });

  it("keeps the next command stoppable after one that can't be started", async () => {
    await runCommand([join(dir, "no-such-command")], 5, dir);
    // Started at once, as the next edit's command is: the failed spawn's late "close" arrives after this.
    writeFileSync(join(dir, "target.txt"), "slow\n");
    const next = runCommand(checkerUnderSh(), 30, dir);
    await vi.waitFor(() => expect(existsSync(join(dir, "checker.pid"))).toBe(true), {
      timeout: 5_000,
      interval: 20,
    });
    stopRunning();
    await vi.waitFor(() => expect(alive(checkerPid())).toBe(false), { timeout: 2_000, interval: 20 });
    expect((await next).code).not.toBe(0);
  });

  it("removes its signal handlers when it returns", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    editsFile([{ id: "a", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" }]);
    await main(["edits.json", "--", ...checker()], deps());
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});

describe("the script", () => {
  const script = join(import.meta.dirname, "mutate.ts");
  const tsx = ["--import", import.meta.resolve("tsx")];

  it("sets the process exit code from main", () => {
    editsFile([{ id: "s", file: "target.txt", find: "const ok", replace: "const fine" }]);
    const result = spawnSync(process.execPath, [...tsx, script, "edits.json", "--", ...checker()], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.stdout).toContain("SURVIVED s target.txt");
    expect(result.status).toBe(1);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "restores the edited file, stops the command and exits 130 on %s",
    async (signal) => {
      editsFile([{ id: "t", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" }]);
      const tmp = join(dir, "tmp");
      mkdirSync(tmp);
      const child = spawn(process.execPath, [...tsx, script, "edits.json", "--", ...checkerUnderSh()], {
        cwd: dir,
        env: { ...process.env, TMPDIR: tmp },
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((done) => child.on("close", done));
      // The edit is written and the checker hangs on it.
      await vi.waitFor(() => expect(existsSync(join(dir, "checker.pid"))).toBe(true), {
        timeout: 10_000,
        interval: 50,
      });
      expect(target()).toContain("slow");
      child.kill(signal);
      expect(await exited).toBe(130);
      expect(stderr).toContain(`${signal}: the edited file is restored`);
      expect(target()).toBe(TARGET);
      // The hung checker was killed too, and the report directory removed. The kill is sent before the
      // script exits, but the checker can take a moment longer to be gone, so wait for it.
      await vi.waitFor(() => expect(alive(checkerPid())).toBe(false), { timeout: 2_000, interval: 20 });
      // (tsx keeps its own cache there too.)
      expect(readdirSync(tmp).filter((name) => name.startsWith("mutate-"))).toEqual([]);
    },
    20_000,
  );
});
