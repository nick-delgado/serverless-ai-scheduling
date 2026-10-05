/**
 * scripts/mutate.ts against a throwaway directory: a target file, a small Node checker standing in for a test
 * command (it fails when the file says "bad", hangs when it says "slow"), and a stand-in `vitest` that writes a
 * Vitest JSON report. Most tests call `main` in-process, because a child process records no coverage; two
 * spawn the script, for its exit code and for the file it restores on SIGINT.
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
  classify,
  DEFAULT_TIMEOUT_SECONDS,
  type EditResult,
  failedTestNames,
  formatResult,
  isVitest,
  main,
  occurrences,
  parseCliArgs,
  stopRunning,
} from "./mutate";

const TARGET = "const ok = true;\nexport const value = ok ? 1 : 2;\n";

// Exits 1 (saying so on stderr) when target.txt says "bad" or holds a "$", exits 0 otherwise. When it says
// "slow" it writes its pid to checker.pid and hangs, but for 30 s at most (far beyond any test's wait), then exits
// 1: a checker a broken kill path leaves behind still ends, and never looks like a passing run.
const CHECKER = `
const fs = require("node:fs");
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
// test when target.txt says "bad"; crashes without a report (printing why) when it says "crash"; else passes.
const FAKE_VITEST = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv.find((a) => a.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
const text = fs.readFileSync("target.txt", "utf8");
if (text.includes("crash")) {
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
const deps = () => ({ cwd: dir, log: (l: string) => out.push(l), logError: (l: string) => errors.push(l) });
const checker = () => ["node", join(dir, "checker.cjs")];
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

describe("parseCliArgs", () => {
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
      cmd: ["npx", "vitest", "--", "x"],
    });
  });

  it("defaults the timeout", () => {
    expect(parseCliArgs(["e.json", "--", "npm", "test"])).toEqual({
      editsFile: "e.json",
      timeout: DEFAULT_TIMEOUT_SECONDS,
      cmd: ["npm", "test"],
    });
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(300);
  });

  it.each([
    [["e.json"], "usage:"],
    [["e.json", "--"], "usage:"],
    [["--", "npm", "test"], "no edits file"],
    [["e.json", "--timeout", "--", "npm"], "--timeout needs a value"],
    [["e.json", "--json", "--", "npm"], "--json needs a value"],
    [["e.json", "--only", "--", "npm"], "--only needs a value"],
    [["e.json", "--only"], "usage:"],
    [["e.json", "f.json", "--", "npm"], "unexpected argument f.json"],
    [["e.json", "--timeout", "0", "--", "npm"], "--timeout must be"],
    [["e.json", "--timeout", "x", "--", "npm"], "--timeout must be"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
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

  it("prints an empty reason for a refused edit with no detail", () => {
    expect(formatResult({ ...result, status: "REFUSED", failedTests: [] })).toEqual([
      "REFUSED 7 a.ts: x⏎y → z",
      "    ()",
    ]);
  });

  it("says why an edit was refused", () => {
    expect(
      formatResult({ ...result, status: "REFUSED", failedTests: [], detail: "find occurs 2 times" }),
    ).toEqual(["REFUSED 7 a.ts: x⏎y → z", "    (find occurs 2 times)"]);
  });
});

describe("main", () => {
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
    expect(out.at(-1)).toBe("\n2 edits: 1 killed, 1 survived, 0 timed out, 0 errors, 0 refused");
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
    expect(out.at(-1)).toBe("\n2 edits: 1 killed, 0 survived, 1 timed out, 0 errors, 0 refused");
    expect(code).toBe(0);
    expect(target()).toBe(TARGET);
  });

  it("kills a timed-out command's whole process group, not only the process it started", async () => {
    // sh stays the parent of the checker (the "; true" keeps it from exec'ing node), so killing sh alone would
    // leave the checker running and holding the output pipe open.
    const edits = editsFile([{ id: "t", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" }]);
    const code = await main(
      [edits, "--timeout", "1", "--", "sh", "-c", `node ${join(dir, "checker.cjs")}; true`],
      deps(),
    );
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
      await main([edits, "--", join(dir, "vitest"), "run"], deps());
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
    const code = await main([edits, "--json", "out.json", "--", join(dir, "vitest"), "run"], deps());
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
    expect(written.cmd).toEqual([join(dir, "vitest"), "run"]);
    expect(written.results.map((r) => [r.id, r.status, r.failedTests])).toEqual([
      ["k", "KILLED", ["target.test.ts > suite rejects bad"]],
      ["e", "ERROR", []],
    ]);
    expect(written.results[0]?.detail).toBeUndefined();
    expect(written.results[1]?.detail).toContain("fake vitest crashed");
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      editsFile([{ id: "a", file: "target.txt", find: "ok ? 1", replace: "bad ? 1" }]);
      expect(await main(["edits.json", "--", ...checker()])).toBe(0);
      expect(log).toHaveBeenCalledWith("KILLED a target.txt: ok ? 1 → bad ? 1");
      expect(await main(["edits.json"])).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: mutate"));
    } finally {
      log.mockRestore();
      error.mockRestore();
      cwd.mockRestore();
    }
  });

  it("stops a running command's process group and removes its report directory when asked", async () => {
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    vi.stubEnv("TMPDIR", tmp);
    try {
      const edits = editsFile([{ id: "t", file: "target.txt", find: "ok ? 1", replace: "slow ? 1" }]);
      const done = main([edits, "--", ...checker()], deps());
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
      expect(alive(checkerPid())).toBe(false);
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
      const child = spawn(process.execPath, [...tsx, script, "edits.json", "--", ...checker()], {
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
      // The hung checker was killed too, before the script exited, and the report directory removed.
      expect(alive(checkerPid())).toBe(false);
      // (tsx keeps its own cache there too.)
      expect(readdirSync(tmp).filter((name) => name.startsWith("mutate-"))).toEqual([]);
    },
    20_000,
  );
});
