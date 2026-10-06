/**
 * scripts/dup-changed.ts: the clone filter on hand-built reports, and `main` with the real jscpd against a throwaway
 * git repository whose feature branch copies a function.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Clone, changedClones, formatClone, main, runJscpd, touchesAdded } from "./dup-changed";
import { gitRepo, logsTo, type TestRepo, withConsole } from "./test/git-repo";

const added = (entries: Record<string, number[]>) =>
  new Map(Object.entries(entries).map(([file, lines]) => [file, lines.map((line) => ({ line, text: "" }))]));
const clone = (a: [string, number, number], b: [string, number, number]): Clone => ({
  firstFile: { name: a[0], start: a[1], end: a[2] },
  secondFile: { name: b[0], start: b[1], end: b[2] },
  lines: a[2] - a[1] + 1,
  tokens: 50,
});

describe("touchesAdded / changedClones", () => {
  const lines = added({ "new.ts": [10, 20] });

  it.each([
    [{ name: "new.ts", start: 10, end: 12 }, true],
    [{ name: "new.ts", start: 5, end: 10 }, true],
    [{ name: "new.ts", start: 11, end: 19 }, false],
    [{ name: "new.ts", start: 21, end: 30 }, false],
    [{ name: "other.ts", start: 10, end: 20 }, false],
  ])("%j → %s", (side, touched) => {
    expect(touchesAdded(side, lines)).toBe(touched);
  });

  it("keeps the clones with a side in added lines, either side, and drops old ones", () => {
    const first = clone(["new.ts", 8, 12], ["old.ts", 1, 5]);
    const second = clone(["old.ts", 1, 5], ["new.ts", 18, 22]);
    const old = clone(["old.ts", 1, 5], ["new.ts", 30, 34]);
    expect(changedClones([first, old, second], lines)).toEqual([first, second]);
  });

  it("prints the side with added lines first", () => {
    const lines2 = added({ "new.ts": [18] });
    expect(formatClone(clone(["old.ts", 1, 5], ["new.ts", 18, 22]), lines2)).toBe(
      "new.ts:18-22 copies old.ts:1-5 (5 lines, 50 tokens)",
    );
    expect(formatClone(clone(["new.ts", 18, 22], ["old.ts", 1, 5]), lines2)).toBe(
      "new.ts:18-22 copies old.ts:1-5 (5 lines, 50 tokens)",
    );
  });
});

// A function long enough for the repository's thresholds (.jscpd.json), and a different one.
const COPIED = `export function total(items: { price: number; count: number }[]): number {
  let sum = 0;
  for (const item of items) {
    if (item.count > 0 && item.price > 0) sum += item.price * item.count;
  }
  return Math.round(sum * 100) / 100;
}
`;
const OTHER = "export const answer = 42;\n";

describe("main", () => {
  let r: TestRepo;
  let repo: string;
  let out: string[];
  let errors: string[];
  const config = join(import.meta.dirname, "..", ".jscpd.json");
  const deps = () => ({ cwd: repo, ...logsTo(out, errors) });

  beforeEach(() => {
    r = gitRepo("dup-changed-");
    repo = r.dir;
    r.write("a.ts", COPIED);
    r.write("b.ts", OTHER);
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    out = [];
    errors = [];
  });
  afterEach(() => r.remove());

  it("fails naming a clone the branch adds, with the side it added first", () => {
    r.write("b.ts", `${OTHER}\n${COPIED.replace("total", "sum")}`);
    r.commit("copy");
    expect(main(["--base", "main", "--config", config], {}, deps())).toBe(1);
    expect(out).toEqual([
      "Clones with a side in lines added since main (1):",
      expect.stringMatching(/^b\.ts:3-9 copies a\.ts:1-7 /),
    ]);
    expect(errors[0]).toContain("jscpd:ignore-start");
  });

  it("passes a clone that was there before the branch, and one fenced with jscpd:ignore", () => {
    r.write("c.ts", COPIED);
    r.commit("old copy");
    r.git("checkout", "-q", "-b", "later");
    r.write("d.ts", `// jscpd:ignore-start -- a test of the fence\n${COPIED}// jscpd:ignore-end\n`);
    r.write("b.ts", `${OTHER}export const more = 1;\n`);
    r.commit("fenced copy");
    expect(main(["--base", "feature", "--config", config], {}, deps())).toBe(0);
    expect(out).toEqual([
      "dup-changed: no clone touches a line added since feature (1 clones in the repository).",
    ]);
  });

  it("reads the base from DUP_BASE, then origin/main (an empty DUP_BASE counts as unset), and .jscpd.json by default", () => {
    r.write("b.ts", `${OTHER}\n${COPIED}`);
    r.commit("copy");
    const detect = vi.fn(() => []);
    expect(main([], { DUP_BASE: "main" }, { ...deps(), detect })).toBe(0);
    expect(out.at(-1)).toContain("since main");
    expect(detect).toHaveBeenCalledWith(join(repo, ".jscpd.json"), repo);
    r.git("update-ref", "refs/remotes/origin/main", "main");
    expect(main([], { DUP_BASE: "" }, { ...deps(), detect })).toBe(0);
    expect(out.at(-1)).toContain("since origin/main");
  });

  it("skips without a merge base locally, and exits 2 for it in CI", () => {
    expect(main(["--base", "nope"], {}, deps())).toBe(0);
    expect(errors[0]).toContain("SKIPPING: no merge base with nope");
    expect(main(["--base", "nope"], { CI: "true" }, deps())).toBe(2);
    expect(errors[1]).toContain("CI must fetch the full history");
  });

  it("exits 2 when jscpd fails, or for an unknown option", () => {
    expect(main(["--base", "main", "--config", join(repo, "missing.json")], {}, deps())).toBe(2);
    expect(errors[0]).toMatch(/^dup-changed: jscpd exited [1-9]/);
    expect(main(["--bogus"], {}, deps())).toBe(2);
    expect(errors[1]).toContain("usage: dup-changed");
  });

  it("runs jscpd in the given directory and returns its clones, removing its report directory", () => {
    r.write("b.ts", COPIED);
    const tmp = join(repo, "tmp");
    mkdirSync(tmp);
    vi.stubEnv("TMPDIR", tmp);
    try {
      expect(runJscpd(config, repo).map((c) => [c.firstFile.name, c.secondFile.name].sort())).toEqual([
        ["a.ts", "b.ts"],
      ]);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("logs to the console, in the process's directory, by default", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(repo);
    try {
      await withConsole((log, error) => {
        expect(main(["--bogus"], {})).toBe(2);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: dup-changed"));
        // A branch with a copy: git and jscpd both run in the (mocked) process directory, so the copy is found.
        r.write("b.ts", COPIED);
        r.commit("copy");
        expect(main(["--base", "main", "--config", config], {})).toBe(1);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^b\.ts:1-7 copies a\.ts:1-7 /));
      });
    } finally {
      cwd.mockRestore();
    }
  });
});
