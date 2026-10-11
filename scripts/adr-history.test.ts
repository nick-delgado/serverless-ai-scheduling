/**
 * An Accepted or amended ADR changes only by amendment (docs/adr/README.md): its body keeps every accepted line, and a
 * changed line only gains a short italic pointer such as *(Refined by the [amendment](#…): …)*. A pointer is history
 * too: one already on the base line stays byte-identical, and only new ones are added, in the amendments as well (#184, B6-1, from the review
 * of PR #175, which rewrote the text inside one). This checks the working tree against the merge base with `origin/main` (or `ADR_BASE`), so an in-place rewrite fails
 * locally and in CI (#139, from the review of PR #124, STD-1 and STD-2). Without that ref it skips locally
 * and fails in CI, which checks out the full history. It covers every ADR whose status starts "Accepted" or that has
 * an `## Amendment (YYYY-MM-DD)` section, so a partly superseded ADR such as ADR-002 is checked too (#240, B9-3).
 *
 * It also checks, in the working tree with no git, that each amendment's date is in its ADR's header (the
 * `**Status:**` or `**Amended:**` line) and in the ADR's row of docs/adr/README.md (#240, B9-3). Each distinct date
 * counts once: a second amendment on the same day isn't checked apart. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** The distinct dates of an ADR's `## Amendment (YYYY-MM-DD)` sections, in order. */
export const amendmentDates = (text: string): string[] => [
  ...new Set([...text.matchAll(/^## Amendment \((\d{4}-\d{2}-\d{2})\)/gm)].map((m) => m[1] as string)),
];

/** The ADRs whose history is checked: Accepted ones, and any with an amendment (ADR-002's status starts otherwise). */
export const isChecked = (text: string) => isAccepted(text) || amendmentDates(text).length > 0;

/** The ADR's header: its `- **Status:**` and `- **Amended:**` lines. */
const header = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("- **Status:**") || line.startsWith("- **Amended:**"))
    .join("\n");

/** The amendment dates missing from the ADR's header, and from its index row (all of them when it has no row). */
export function missingDates(
  text: string,
  indexRow: string | undefined,
): { header: string[]; index: string[] } {
  const dates = amendmentDates(text);
  return {
    header: dates.filter((date) => !header(text).includes(date)),
    index: dates.filter((date) => !(indexRow ?? "").includes(date)),
  };
}

/** The row of docs/adr/README.md that links the ADR file `name` (such as `0002-model-and-bedrock-client.md`). */
export const indexRow = (index: string, name: string): string | undefined =>
  index.split("\n").find((line) => line.startsWith("| [") && line.includes(`](${name.slice(0, 5)}`));

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

  it("flags one of two identical pointers dropped", () => {
    const twice = base.replace("We use X.", "We use X. *(Refined: a.)* *(Refined: a.)*");
    expect(lostLines(twice, twice.replace(" *(Refined: a.)*", ""))).toEqual([
      "We use X. *(Refined: a.)* *(Refined: a.)*",
    ]);
  });

  it("flags a pointer rewritten in place, removed, or reordered", () => {
    const pointed = base.replace("We use X.", "We use X. *(Refined: a.)* *(Superseded: b.)*");
    const line = "We use X. *(Refined: a.)* *(Superseded: b.)*";
    expect(lostLines(pointed, pointed.replace("a.)*", "a, and done.)*"))).toEqual([line]);
    expect(lostLines(pointed, pointed.replace(" *(Superseded: b.)*", ""))).toEqual([line]);
    expect(lostLines(pointed, pointed.replace(line, "We use X. *(Superseded: b.)* *(Refined: a.)*"))).toEqual(
      [line],
    );
  });

  it("flags a pointer rewritten or removed in an amendment, where line edits pass (PR #175's ADR-008 edit)", () => {
    const pointed = base.replace("Old.", "Old. *(Done in #1.)* *(Done in #1.)*");
    expect(lostPointers(pointed, pointed.replace("Old.", "New."))).toEqual([]);
    expect(lostPointers(pointed, pointed.replace("Old.", "New. *(Done in #2.)*"))).toEqual([]);
    expect(
      lostPointers(pointed, pointed.replace("*(Done in #1.)* *(", "*(Done in #1, and #2.)* *(")),
    ).toEqual(["*(Done in #1.)*"]);
    expect(lostPointers(pointed, pointed.replace(" *(Done in #1.)*", ""))).toEqual(["*(Done in #1.)*"]);
  });

  it("checks an ADR with an amendment whatever its status, and an Accepted one without", () => {
    expect(isChecked("- **Status:** Client decision superseded\n\n## Amendment (2026-10-09): x\n")).toBe(
      true,
    );
    expect(isChecked("- **Status:** Accepted\n")).toBe(true);
    expect(isChecked("- **Status:** Proposed\n\n## Amendments\n")).toBe(false);
  });

  it("flags a body line removed, and a heading renamed", () => {
    expect(lostLines(base, base.replace("We log Y.\n", "").replace("## Decision", "## Choice"))).toEqual([
      "## Decision",
      "We log Y.",
    ]);
  });
});

describe("missingDates", () => {
  const adr = [
    "# ADR-002: X",
    "",
    "- **Status:** Accepted (amended 2026-10-01: a)",
    "- **Amended:** 2026-10-03 (b)",
    "",
    "## Decision",
    "Body naming 2026-10-05.",
    "## Amendment (2026-10-01): a (#1)",
    "## Amendment (2026-10-03): b (#2)",
    "## Amendment (2026-10-03): c (#3)",
    "## Amendment (2026-10-05): d (#4)",
  ].join("\n");
  const row = "| [002](0002-x.md) | X | Accepted (amended 2026-10-01, 2026-10-03, twice; 2026-10-05) |";

  it("passes when each distinct date is in the header and the index row", () => {
    const amended = adr.replace("2026-10-03 (b)", "2026-10-03 (b); 2026-10-05 (d)");
    expect(missingDates(amended, row)).toEqual({ header: [], index: [] });
  });

  it("flags a date the header lacks (a body line doesn't count), or the index row lacks, or no row", () => {
    expect(missingDates(adr, row.replace("2026-10-01, ", ""))).toEqual({
      header: ["2026-10-05"],
      index: ["2026-10-01"],
    });
    expect(missingDates(adr, undefined).index).toEqual(["2026-10-01", "2026-10-03", "2026-10-05"]);
  });

  it("finds an ADR's row by its link", () => {
    const index = `| ADR | Title | Status |\n|---|---|---|\n${row}\n| [003](0003-y.md) | names 0002-x.md | Accepted |\n`;
    expect(indexRow(index, "0002-x.md")).toBe(row);
    expect(indexRow(index, "0004-z.md")).toBeUndefined();
  });
});

const adrFiles = readdirSync(join(root, "docs/adr")).filter((name) => /^\d{4}-.*\.md$/.test(name));
const adrIndex = readFileSync(join(root, "docs/adr/README.md"), "utf8");

describe("each amendment date is in its ADR's header and index row", () => {
  it("finds the amended ADRs", () => {
    expect(adrFiles.length).toBeGreaterThan(5);
  });

  it.each(adrFiles)("%s", (name) => {
    const missing = missingDates(
      readFileSync(join(root, "docs/adr", name), "utf8"),
      indexRow(adrIndex, name),
    );
    expect(missing.header, "add each date to the Status or Amended line").toEqual([]);
    expect(missing.index, "add each date to the ADR's row in docs/adr/README.md").toEqual([]);
  });
});

const base = mergeBase();
const accepted = base
  ? git("ls-tree", "--name-only", base, "docs/adr/")
      .split("\n")
      .filter((f) => /^docs\/adr\/\d{4}-.*\.md$/.test(f))
      .map((file) => ({ file, text: git("show", `${base}:${file}`) }))
      .filter(({ text }) => isChecked(text))
  : [];

describe.skipIf(!base)("Accepted or amended ADRs keep their accepted body text", () => {
  it("finds the Accepted or amended ADRs at the merge base, ADR-002 among them", () => {
    expect(accepted.length).toBeGreaterThan(5);
    expect(accepted.map(({ file }) => file)).toContain("docs/adr/0002-model-and-bedrock-client.md");
  });

  it.each(accepted.map(({ file, text }) => [file, text]))("%s", (file, text) => {
    const path = join(root, file);
    expect(existsSync(path), `${file} was deleted; supersede it with a new ADR instead`).toBe(true);
    const head = readFileSync(path, "utf8");
    expect(lostLines(text, head)).toEqual([]);
    expect(lostPointers(text, head), "a pointer is history: add a new one instead").toEqual([]);
  });
});
