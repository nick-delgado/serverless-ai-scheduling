/**
 * An Accepted ADR changes only by amendment (docs/adr/README.md): its body keeps every accepted line, and a
 * changed line only gains a short italic pointer such as *(Refined by the [amendment](#…): …)*. This checks
 * the working tree against the merge base with `origin/main` (or `ADR_BASE`), so an in-place rewrite fails
 * locally and in CI (#139, from the review of PR #124, STD-1 and STD-2). Without that ref it skips locally
 * and fails in CI, which checks out the full history.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

function mergeBase(): string | undefined {
  const ref = process.env.ADR_BASE ?? "origin/main";
  try {
    return git("merge-base", "HEAD", ref).trim();
  } catch (err) {
    if (process.env.CI)
      throw new Error(`adr-history: no merge base with ${ref} (CI must fetch full history)`, { cause: err });
    process.stderr.write(
      `\n[adr-history] SKIPPING: no merge base with ${ref} (set ADR_BASE or fetch origin).\n`,
    );
    return undefined;
  }
}

/** The text with appended pointers *( … )* removed (one level of nested parentheses, for links) and spaces collapsed. */
export const normalise = (line: string) =>
  line
    .replace(/\s*\*\((?:[^()]|\([^()]*\))*\)\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The decision body: from the first `## ` heading up to the first `## Amendment`, blank lines dropped. */
export function bodyLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## "));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## Amendment"));
  return lines.slice(start, end < 0 ? undefined : end).filter((l) => l.trim() !== "");
}

/** Body lines of `base` whose text (pointers aside) no longer appears anywhere in `head`. */
export function lostLines(base: string, head: string): string[] {
  const kept = new Set(head.split("\n").map(normalise));
  return bodyLines(base).filter((l) => !kept.has(normalise(l)));
}

const isAccepted = (text: string) => /^- \*\*Status:\*\* Accepted\b/m.test(text);

describe("normalise / lostLines", () => {
  const base =
    "# ADR\n\n- **Status:** Accepted\n\n## Decision\nWe use X.\nWe log Y.\n\n## Amendment (2026-10-03): z\nOld.\n";

  it("passes when a body line only gains a pointer, and when amendments change", () => {
    const head = base
      .replace("We use X.", "We use X. *(Refined by the [amendment](#amendment-2026-10-03-z): X v2.)*")
      .replace("Old.", "New.");
    expect(lostLines(base, head)).toEqual([]);
  });

  it("flags a body line rewritten in place", () => {
    expect(lostLines(base, base.replace("We use X.", "We use X v2."))).toEqual(["We use X."]);
  });

  it("flags a body line removed, and a heading renamed", () => {
    expect(lostLines(base, base.replace("We log Y.\n", "").replace("## Decision", "## Choice"))).toEqual([
      "## Decision",
      "We log Y.",
    ]);
  });
});

const base = mergeBase();
const accepted = base
  ? git("ls-tree", "--name-only", base, "docs/adr/")
      .split("\n")
      .filter((f) => /^docs\/adr\/\d{4}-.*\.md$/.test(f))
      .map((file) => ({ file, text: git("show", `${base}:${file}`) }))
      .filter(({ text }) => isAccepted(text))
  : [];

describe.skipIf(!base)("Accepted ADRs keep their accepted body text", () => {
  it("finds the accepted ADRs at the merge base", () => {
    expect(accepted.length).toBeGreaterThan(5);
  });

  it.each(accepted.map(({ file, text }) => [file, text]))("%s", (file, text) => {
    const path = join(root, file);
    expect(existsSync(path), `${file} was deleted; supersede it with a new ADR instead`).toBe(true);
    expect(lostLines(text, readFileSync(path, "utf8"))).toEqual([]);
  });
});
