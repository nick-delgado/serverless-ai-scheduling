/**
 * An Accepted ADR changes only by amendment (docs/adr/README.md): its body keeps every accepted line, and a
 * changed line only gains a short italic pointer such as *(Refined by the [amendment](#…): …)*. A pointer is history
 * too: one already on the base line stays byte-identical, and only new ones are added, in the amendments as well (#184, B6-1, from the review
 * of PR #175, which rewrote the text inside one). This checks the working tree against the merge base with `origin/main` (or `ADR_BASE`), so an in-place rewrite fails
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

/** An italic pointer *( … )*, allowing one level of nested parentheses (for links). */
const POINTER = /\s*\*\((?:[^()]|\([^()]*\))*\)\*/g;

/** The text with appended pointers *( … )* removed and spaces collapsed. */
export const normalise = (line: string) => line.replace(POINTER, "").replace(/\s+/g, " ").trim();

/** The line's pointers, in order, each exactly as written. */
export const pointers = (line: string) => [...line.matchAll(POINTER)].map((m) => m[0].trim());

/** True when every pointer of `base` is in `head`, unchanged and in the same order (new ones may sit between). */
export function keepsPointers(base: string, head: string): boolean {
  const added = pointers(head);
  let i = 0;
  for (const pointer of pointers(base)) {
    i = added.indexOf(pointer, i);
    if (i < 0) return false;
    i += 1;
  }
  return true;
}

/** The decision body: from the first `## ` heading up to the first `## Amendment`, blank lines dropped. */
export function bodyLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## "));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## Amendment"));
  return lines.slice(start, end < 0 ? undefined : end).filter((l) => l.trim() !== "");
}

/** Body lines of `base` that no line of `head` keeps: the same text (pointers aside) and every base pointer intact. */
export function lostLines(base: string, head: string): string[] {
  const kept = new Map<string, string[]>();
  for (const line of head.split("\n"))
    kept.set(normalise(line), [...(kept.get(normalise(line)) ?? []), line]);
  return bodyLines(base).filter((l) => !(kept.get(normalise(l)) ?? []).some((h) => keepsPointers(l, h)));
}

/**
 * Pointers of `base`, anywhere in the file (amendments included), that `head` no longer has byte for byte, counted
 * per copy. An amendment's own lines may change, but a pointer on them is a status note like any other: PR #175
 * rewrote one in the 2026-09-29 amendment of ADR-008.
 */
export function lostPointers(base: string, head: string): string[] {
  const left = pointers(head);
  return pointers(base).filter((pointer) => {
    const i = left.indexOf(pointer);
    if (i >= 0) left.splice(i, 1);
    return i < 0;
  });
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

  it("passes when a line with a pointer gains a second one, before or after it", () => {
    const pointed = base.replace("We use X.", "We use X. *(Refined: a.)*");
    expect(
      lostLines(pointed, pointed.replace("*(Refined: a.)*", "*(Refined: a.)* *(Superseded: b.)*")),
    ).toEqual([]);
    expect(lostLines(pointed, pointed.replace("We use X.", "We use X. *(Superseded: b.)*"))).toEqual([]);
  });

  it("flags a pointer rewritten in place, removed, or reordered (PR #175's ADR-008 edit)", () => {
    const pointed = base.replace("We use X.", "We use X. *(Refined: a.)* *(Superseded: b.)*");
    const line = "We use X. *(Refined: a.)* *(Superseded: b.)*";
    expect(lostLines(pointed, pointed.replace("a.)*", "a, and done.)*"))).toEqual([line]);
    expect(lostLines(pointed, pointed.replace(" *(Superseded: b.)*", ""))).toEqual([line]);
    expect(lostLines(pointed, pointed.replace(line, "We use X. *(Superseded: b.)* *(Refined: a.)*"))).toEqual(
      [line],
    );
  });

  it("flags a pointer rewritten or removed in an amendment, where line edits pass", () => {
    const pointed = base.replace("Old.", "Old. *(Done in #1.)* *(Done in #1.)*");
    expect(lostPointers(pointed, pointed.replace("Old.", "New."))).toEqual([]);
    expect(lostPointers(pointed, pointed.replace("Old.", "New. *(Done in #2.)*"))).toEqual([]);
    expect(
      lostPointers(pointed, pointed.replace("*(Done in #1.)* *(", "*(Done in #1, and #2.)* *(")),
    ).toEqual(["*(Done in #1.)*"]);
    expect(lostPointers(pointed, pointed.replace(" *(Done in #1.)*", ""))).toEqual(["*(Done in #1.)*"]);
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
    const head = readFileSync(path, "utf8");
    expect(lostLines(text, head)).toEqual([]);
    expect(lostPointers(text, head), "a pointer is history: add a new one instead").toEqual([]);
  });
});
