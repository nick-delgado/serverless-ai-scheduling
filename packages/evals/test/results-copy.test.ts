/**
 * The copy of each run's results outside the checkout (`src/results-copy.ts`, #195): where it goes, the
 * repository-containment refusal, the early directory check, and the writes, against a temp directory.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkoutRoots,
  CliArgError,
  isInsideDir,
  prepareResultsCopyDir,
  RESULTS_COPY_DIR_ENV,
  resultsCopyBaseDir,
  resultsCopyDir,
  resultsWrittenMessages,
  writeRunResults,
} from "../src";

const HOME = "/home/pat";
const STAMPED = "2026-10-06T101500Z-scenario-smoke-sonnet-4.6";
const report = {
  startedAt: "2026-10-06T10:15:00.123Z",
  mode: "scenario" as const,
  suite: "smoke" as const,
  profile: "sonnet-4.6",
};

describe("resultsCopyBaseDir", () => {
  it("defaults to ~/.local/state/serverless-ai-scheduling/eval-results", () => {
    expect(resultsCopyBaseDir({}, HOME)).toBe("/home/pat/.local/state/serverless-ai-scheduling/eval-results");
  });

  it("uses an absolute XDG_STATE_HOME", () => {
    expect(resultsCopyBaseDir({ XDG_STATE_HOME: "/xdg/state" }, HOME)).toBe(
      "/xdg/state/serverless-ai-scheduling/eval-results",
    );
  });

  it("ignores a relative XDG_STATE_HOME, as the XDG spec says", () => {
    expect(resultsCopyBaseDir({ XDG_STATE_HOME: "rel/state" }, HOME)).toBe(
      "/home/pat/.local/state/serverless-ai-scheduling/eval-results",
    );
  });

  it("lets EVAL_RESULTS_COPY_DIR replace the directory, over XDG_STATE_HOME", () => {
    expect(resultsCopyBaseDir({ [RESULTS_COPY_DIR_ENV]: "/keep/evals/", XDG_STATE_HOME: "/xdg" }, HOME)).toBe(
      "/keep/evals",
    );
  });

  it("treats an empty EVAL_RESULTS_COPY_DIR as unset", () => {
    expect(resultsCopyBaseDir({ [RESULTS_COPY_DIR_ENV]: "" }, HOME)).toBe(
      "/home/pat/.local/state/serverless-ai-scheduling/eval-results",
    );
  });

  it("refuses a relative EVAL_RESULTS_COPY_DIR as a usage error", () => {
    expect(() => resultsCopyBaseDir({ [RESULTS_COPY_DIR_ENV]: "keep" }, HOME)).toThrow(
      new CliArgError("EVAL_RESULTS_COPY_DIR must be an absolute path, got keep"),
    );
  });
});

describe("checkoutRoots and isInsideDir", () => {
  it("a worktree under .worktrees/ also guards the checkout that holds it", () => {
    expect(checkoutRoots("/r/repo/.worktrees/195-copy/")).toEqual(["/r/repo/.worktrees/195-copy", "/r/repo"]);
  });

  it("the main checkout is its own only root", () => {
    expect(checkoutRoots("/r/repo")).toEqual(["/r/repo"]);
  });

  it("is inside for the root itself and anything below it, after resolving ..", () => {
    expect(isInsideDir("/r/repo", "/r/repo")).toBe(true);
    expect(isInsideDir("/r/repo/a/b", "/r/repo")).toBe(true);
    expect(isInsideDir("/r/other/../repo/x", "/r/repo")).toBe(true);
    expect(isInsideDir("/r/repo/..x", "/r/repo")).toBe(true);
  });

  it("is outside for a parent, a sibling, or a name that only starts with the root's", () => {
    expect(isInsideDir("/r", "/r/repo")).toBe(false);
    expect(isInsideDir("/r/other", "/r/repo")).toBe(false);
    expect(isInsideDir("/r/repo-copy", "/r/repo")).toBe(false);
    expect(isInsideDir("/r/repo/../..x", "/r/repo")).toBe(false);
  });
});

describe("resultsCopyDir", () => {
  it("adds one subdirectory per checkout, named after its directory", () => {
    expect(resultsCopyDir({ env: {}, home: HOME, checkout: "/r/repo/.worktrees/195-copy" })).toBe(
      "/home/pat/.local/state/serverless-ai-scheduling/eval-results/195-copy",
    );
    expect(resultsCopyDir({ env: {}, home: HOME, checkout: "/r/repo" })).toBe(
      "/home/pat/.local/state/serverless-ai-scheduling/eval-results/repo",
    );
  });

  it("refuses a copy directory inside the running worktree", () => {
    const env = { [RESULTS_COPY_DIR_ENV]: "/r/repo/.worktrees/195-copy/keep" };
    expect(() => resultsCopyDir({ env, home: HOME, checkout: "/r/repo/.worktrees/195-copy" })).toThrow(
      new CliArgError(
        "the results copy directory /r/repo/.worktrees/195-copy/keep/195-copy is inside the repository checkout /r/repo/.worktrees/195-copy; set EVAL_RESULTS_COPY_DIR to a directory outside it",
      ),
    );
  });

  it("refuses a copy directory inside the checkout that holds the worktree", () => {
    const env = { [RESULTS_COPY_DIR_ENV]: "/r/repo/keep" };
    expect(() => resultsCopyDir({ env, home: HOME, checkout: "/r/repo/.worktrees/195-copy" })).toThrow(
      /inside the repository checkout \/r\/repo;/,
    );
  });

  it("refuses an override that is the main checkout's parent, where the files would land in the checkout", () => {
    const env = { [RESULTS_COPY_DIR_ENV]: "/r" };
    expect(() => resultsCopyDir({ env, home: HOME, checkout: "/r/repo" })).toThrow(
      new CliArgError(
        "the results copy directory /r/repo is inside the repository checkout /r/repo; set EVAL_RESULTS_COPY_DIR to a directory outside it",
      ),
    );
  });

  it("accepts the same parent override from a worktree, whose copy lands beside the checkout", () => {
    const env = { [RESULTS_COPY_DIR_ENV]: "/r" };
    expect(resultsCopyDir({ env, home: HOME, checkout: "/r/repo/.worktrees/195-copy" })).toBe("/r/195-copy");
  });

  it("refuses a default that lands inside the checkout (a home inside the repo)", () => {
    expect(() => resultsCopyDir({ env: {}, home: "/r/repo", checkout: "/r/repo" })).toThrow(CliArgError);
  });
});

describe("the writes, against a temp directory", () => {
  let tmp = "";
  const dir = (): string => (tmp = mkdtempSync(join(tmpdir(), "evals-results-copy-")));
  afterEach(() => {
    if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("prepareResultsCopyDir creates the directory, parents included", () => {
    const copy = join(dir(), "state", "eval-results", "195-copy");
    prepareResultsCopyDir(copy);
    expect(existsSync(copy)).toBe(true);
  });

  it("prepareResultsCopyDir turns a failure into a usage error naming the directory", () => {
    const fail = (): never => {
      throw new Error("EACCES: permission denied");
    };
    expect(() => prepareResultsCopyDir("/nope/copy", { mkdir: fail })).toThrow(
      new CliArgError("can't create the results copy directory /nope/copy: Error: EACCES: permission denied"),
    );
  });

  it("writes the .json and .md pair to the primary directory and to the copy", () => {
    const root = dir();
    const out = join(root, "checkout", "results");
    const copyDir = join(root, "state", "195-copy");
    const written = writeRunResults(report, "# summary", { out, copyDir });
    expect(written).toEqual({ primary: join(out, STAMPED), copy: join(copyDir, STAMPED) });
    for (const d of [out, copyDir]) {
      expect(readdirSync(d).sort()).toEqual([`${STAMPED}.json`, `${STAMPED}.md`]);
      expect(JSON.parse(readFileSync(join(d, `${STAMPED}.json`), "utf8"))).toEqual(report);
      expect(readFileSync(join(d, `${STAMPED}.md`), "utf8")).toBe("# summary\n");
    }
  });

  it("writes the primary pair before the copy", () => {
    const order: string[] = [];
    writeRunResults(
      report,
      "md",
      { out: "/p", copyDir: "/c" },
      { mkdir: (d) => order.push(`mkdir ${d}`), writeFile: (p) => order.push(p) },
    );
    expect(order).toEqual([
      "mkdir /p",
      `/p/${STAMPED}.json`,
      `/p/${STAMPED}.md`,
      "mkdir /c",
      `/c/${STAMPED}.json`,
      `/c/${STAMPED}.md`,
    ]);
  });

  it("writes the pair once when the copy and the primary resolve to the same directory", () => {
    const writes: string[] = [];
    const files = { mkdir: () => undefined, writeFile: (p: string) => writes.push(p) };
    // A relative --out naming the copy directory, as `npm run evals -- --out <relative>` would pass it.
    const out = relative(process.cwd(), "/same/dir");
    const written = writeRunResults(report, "md", { out, copyDir: "/same/x/../dir/" }, files);
    expect(written).toEqual({ primary: join(out, STAMPED) });
    expect(writes).toEqual([join(out, `${STAMPED}.json`), join(out, `${STAMPED}.md`)]);
  });

  it("returns a failed copy write as copyError, with the primary pair already written", () => {
    const root = dir();
    const out = join(root, "results");
    // A file where the copy's parent directory should be: mkdir fails even for root.
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "");
    const copyDir = join(blocker, "195-copy");
    const written = writeRunResults(report, "md", { out, copyDir });
    expect(written.primary).toBe(join(out, STAMPED));
    expect(written.copy).toBe(join(copyDir, STAMPED));
    expect(written.copyError).toMatch(/ENOTDIR|EEXIST/);
    expect(existsSync(`${written.primary}.json`)).toBe(true);
  });

  it("lets a failed primary write throw, as before, without writing the copy", () => {
    const writes: string[] = [];
    const files = {
      mkdir: (d: string) => {
        if (d === "/p") throw new Error("ENOSPC");
      },
      writeFile: (p: string) => writes.push(p),
    };
    expect(() => writeRunResults(report, "md", { out: "/p", copyDir: "/c" }, files)).toThrow("ENOSPC");
    expect(writes).toEqual([]);
  });
});

describe("resultsWrittenMessages", () => {
  it("names both .json paths on the last line", () => {
    expect(resultsWrittenMessages({ primary: "/p/run", copy: "/c/run" })).toEqual({
      line: "evals: wrote /p/run.json and the copy /c/run.json",
    });
  });

  it("names the path once when the copy is the primary", () => {
    expect(resultsWrittenMessages({ primary: "/p/run" })).toEqual({
      line: "evals: wrote /p/run.json (also the copy location)",
    });
  });

  it("warns, naming the copy path and the error, when the copy failed", () => {
    expect(resultsWrittenMessages({ primary: "/p/run", copy: "/c/run", copyError: "Error: EACCES" })).toEqual(
      {
        line: "evals: wrote /p/run.json; the copy /c/run.json was not written",
        warning: "evals: warning: couldn't write the results copy /c/run.json: Error: EACCES",
      },
    );
  });
});
