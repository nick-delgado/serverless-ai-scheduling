/**
 * Keep-in-sync regions (#156, from the reviews of PR #153, STD-1, and PR #155, STD-1). A fact restated in
 * two files is marked in each with a `sync-start:<name>` line and a `sync-end:<name>` line, in whatever
 * comment the file uses. When a branch changes the region in one file, it changes the region in every other
 * file with that name, or one of its commits carries the trailer `Sync-checked: <name>` (the other copies
 * still hold). This checks the working tree against the merge base with `origin/main` (or `SYNC_BASE`), as
 * `scripts/adr-history.test.ts` does: without that ref it skips locally and fails in CI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MARKER = /\bsync-(start|end):([a-z0-9][a-z0-9-]*)/;

/** The regions marked in one file, by name. Throws on a marker without its partner, or a name used twice. */
export function regionsOf(text: string, path: string): Map<string, string> {
  const regions = new Map<string, string>();
  let open: { name: string; from: number } | undefined;
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = MARKER.exec(line);
    if (!m) continue;
    const [, kind = "", name = ""] = m;
    if (kind === "start") {
      if (open) throw new Error(`${path}:${i + 1}: sync-start:${name} inside sync-start:${open.name}`);
      if (regions.has(name)) throw new Error(`${path}:${i + 1}: sync region ${name} marked twice`);
      open = { name, from: i + 1 };
    } else {
      if (!open || open.name !== name)
        throw new Error(`${path}:${i + 1}: sync-end:${name} without its sync-start`);
      regions.set(name, lines.slice(open.from, i).join("\n"));
      open = undefined;
    }
  }
  if (open) throw new Error(`${path}: sync-start:${open.name} has no sync-end`);
  return regions;
}

/** Region text per name, per file. */
export type Snapshot = Map<string, Map<string, string>>;

export function snapshot(files: Record<string, string>): Snapshot {
  const byName: Snapshot = new Map();
  for (const [path, text] of Object.entries(files)) {
    for (const [name, body] of regionsOf(text, path)) {
      const copies = byName.get(name) ?? new Map<string, string>();
      copies.set(path, body);
      byName.set(name, copies);
    }
  }
  return byName;
}

/**
 * One problem per name: a region marked in a single file, or a region changed since `base` in some files and
 * not in others, unless `checked` (the branch's `Sync-checked` trailers) names it.
 */
export function unsynced(base: Snapshot, head: Snapshot, checked: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const [name, copies] of head) {
    if (copies.size < 2) {
      problems.push(`sync region ${name} is marked only in ${[...copies.keys()].join("")}`);
      continue;
    }
    if (checked.has(name)) continue;
    const before = base.get(name);
    const changed = [...copies].filter(([path, body]) => before?.get(path) !== body).map(([path]) => path);
    const unchanged = [...copies.keys()].filter((path) => !changed.includes(path));
    if (changed.length > 0 && unchanged.length > 0) {
      problems.push(
        `sync region ${name} changed in ${changed.join(", ")} but not in ${unchanged.join(", ")}: ` +
          `update it there, or add the trailer "Sync-checked: ${name}" to a commit if it still holds`,
      );
    }
  }
  return problems;
}

describe("regionsOf", () => {
  it("returns each region's lines between its markers, in any comment style", () => {
    const text =
      "a\n// sync-start:x\none\ntwo\n// sync-end:x\n<!-- sync-start:y -->\nthree\n<!-- sync-end:y -->";
    expect(regionsOf(text, "f")).toEqual(
      new Map([
        ["x", "one\ntwo"],
        ["y", "three"],
      ]),
    );
  });

  it("ignores words that only contain the marker text, and a placeholder name", () => {
    expect(regionsOf("async:x\nresync-start:y\nsync-start:<name>\nunsync-end:z", "f")).toEqual(new Map());
  });

  it.each([
    ["an end without a start", "sync-end:x", "f:1: sync-end:x without its sync-start"],
    ["a start without an end", "sync-start:x\nbody", "f: sync-start:x has no sync-end"],
    ["a mismatched end", "sync-start:x\nsync-end:y", "f:2: sync-end:y without its sync-start"],
    ["a nested start", "sync-start:x\nsync-start:y", "f:2: sync-start:y inside sync-start:x"],
    ["a name used twice", "sync-start:x\nsync-end:x\nsync-start:x", "f:3: sync region x marked twice"],
  ])("throws on %s", (_, text, message) => {
    expect(() => regionsOf(text, "f")).toThrow(message);
  });
});

describe("unsynced", () => {
  const pair = (a: string, b: string) =>
    snapshot({
      "a.ts": `// sync-start:x\n${a}\n// sync-end:x`,
      "b.md": `<!-- sync-start:x -->\n${b}\n<!-- sync-end:x -->`,
    });
  const base = pair("one", "one");
  const none = new Set<string>();

  it("passes when no copy changed, and when every copy changed", () => {
    expect(unsynced(base, pair("one", "one"), none)).toEqual([]);
    expect(unsynced(base, pair("two", "deux"), none)).toEqual([]);
  });

  it("names the unchanged file when only one copy changed", () => {
    expect(unsynced(base, pair("two", "one"), none)).toEqual([
      'sync region x changed in a.ts but not in b.md: update it there, or add the trailer "Sync-checked: x" to a commit if it still holds',
    ]);
  });

  it("passes a one-sided change that a Sync-checked trailer names, and only that name", () => {
    expect(unsynced(base, pair("two", "one"), new Set(["x"]))).toEqual([]);
    expect(unsynced(base, pair("two", "one"), new Set(["y"]))).toHaveLength(1);
  });

  it("counts a region new in one file as a change there", () => {
    const head = snapshot({
      "a.ts": "// sync-start:x\none\n// sync-end:x",
      "b.md": "<!-- sync-start:x -->\none\n<!-- sync-end:x -->",
      "c.md": "<!-- sync-start:x -->\none\n<!-- sync-end:x -->",
    });
    expect(unsynced(base, head, none)).toEqual([
      'sync region x changed in c.md but not in a.ts, b.md: update it there, or add the trailer "Sync-checked: x" to a commit if it still holds',
    ]);
  });

  it("passes a pair added on the branch", () => {
    expect(unsynced(new Map(), base, none)).toEqual([]);
  });

  it("flags a region marked in one file only, even with a trailer", () => {
    const head = snapshot({ "a.ts": "// sync-start:x\none\n// sync-end:x" });
    expect(unsynced(new Map(), head, new Set(["x"]))).toEqual(["sync region x is marked only in a.ts"]);
  });
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
/** This file and its docs quote the markers; they are not regions. */
const SELF = new Set(["scripts/sync-regions.test.ts"]);

function mergeBase(): string | undefined {
  const ref = process.env.SYNC_BASE ?? "origin/main";
  try {
    return git("merge-base", "HEAD", ref).trim();
  } catch (err) {
    if (process.env.CI)
      throw new Error(`sync-regions: no merge base with ${ref} (CI must fetch full history)`, { cause: err });
    process.stderr.write(
      `\n[sync-regions] SKIPPING: no merge base with ${ref} (set SYNC_BASE or fetch origin).\n`,
    );
    return undefined;
  }
}

/** Tracked files holding a marker: in the working tree, or at `rev`. */
function markedFiles(rev?: string): string[] {
  const args = ["grep", "-l", "-E", "sync-(start|end):[a-z0-9]", ...(rev ? [rev] : []), "--", "."];
  let out: string;
  try {
    out = git(...args);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => (rev ? line.slice(rev.length + 1) : line))
    .filter((path) => !SELF.has(path));
}

const base = mergeBase();

describe.runIf(base !== undefined)("sync regions on this branch", () => {
  it("change together, or carry a Sync-checked trailer", () => {
    const rev = base as string;
    const head = snapshot(
      Object.fromEntries(markedFiles().map((p) => [p, readFileSync(join(root, p), "utf8")] as const)),
    );
    const before = snapshot(
      Object.fromEntries(markedFiles(rev).map((p) => [p, git("show", `${rev}:${p}`)] as const)),
    );
    const checked = new Set(
      git("log", "--format=%(trailers:key=Sync-checked,valueonly)", `${rev}..HEAD`)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    expect(unsynced(before, head, checked)).toEqual([]);
  });
});
