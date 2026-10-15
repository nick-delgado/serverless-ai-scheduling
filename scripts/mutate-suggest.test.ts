/**
 * scripts/mutate-suggest.ts: `suggestEdits` and `regexParts` against hand-written code, and `npm run mutate --
 * --suggest` (through `mutate`'s `main`) against a throwaway git repository whose feature branch adds lines.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main as mutate, readEdits } from "./mutate";
import { regexParts, type SuggestedEdit, suggestEdits } from "./mutate-suggest";
import { gitRepo, logsTo, type TestRepo, withConsole } from "./test/git-repo";

/** The edits for `text` with every line added. */
const all = (text: string) => suggestEdits("a.ts", text, new Set(text.split("\n").map((_, i) => i + 1)));

/** The text each edit leaves, as the runner writes it, with the edit's note. */
const applied = (text: string, edits: readonly SuggestedEdit[]) =>
  edits.map((edit) => [edit.note, text.replace(edit.find, () => edit.replace)]);

describe("suggestEdits", () => {
  it("drops each operand of #238's .filter chain and flips its ===, three edits in all", () => {
    const text = 'const ok = calls.filter((c) => c.name === "escalate_to_human" && c.ok);\n';
    const { edits, skipped } = all(text);
    expect(applied(text, edits)).toEqual([
      ["drop-operand", "const ok = calls.filter((c) => c.ok);\n"],
      ["flip-equality", 'const ok = calls.filter((c) => c.name !== "escalate_to_human" && c.ok);\n'],
      ["drop-operand", 'const ok = calls.filter((c) => c.name === "escalate_to_human");\n'],
    ]);
    expect(skipped).toBe(0);
    expect(edits.every((edit) => edit.file === "a.ts" && edit.expect.length === 0)).toBe(true);
  });

  it("removes each of the four lookarounds of #238's italics regex, and no alternative", () => {
    const text = "const ITALIC = /(?<!\\*)\\*(?![\\s*])[^*]*?(?<![\\s*])\\*(?!\\*)/;\n";
    expect(applied(text, all(text).edits)).toEqual([
      ["regex-lookaround", "const ITALIC = /\\*(?![\\s*])[^*]*?(?<![\\s*])\\*(?!\\*)/;\n"],
      ["regex-lookaround", "const ITALIC = /(?<!\\*)\\*[^*]*?(?<![\\s*])\\*(?!\\*)/;\n"],
      ["regex-lookaround", "const ITALIC = /(?<!\\*)\\*(?![\\s*])[^*]*?\\*(?!\\*)/;\n"],
      ["regex-lookaround", "const ITALIC = /(?<!\\*)\\*(?![\\s*])[^*]*?(?<![\\s*])\\*/;\n"],
    ]);
  });

  it("flattens a one-operator chain, keeps a mixed or parenthesised operand whole, and skips &&=", () => {
    expect(applied("f(a && b && c);", all("f(a && b && c);").edits)).toEqual([
      ["drop-operand", "f(b && c);"],
      ["drop-operand", "f(a && c);"],
      ["drop-operand", "f(a && b);"],
    ]);
    expect(applied("f(a || b && c);", all("f(a || b && c);").edits)).toEqual([
      ["drop-operand", "f(b && c);"],
      ["drop-operand", "f(a);"],
      ["drop-operand", "f(a || c);"],
      ["drop-operand", "f(a || b);"],
    ]);
    expect(applied("f((a ?? b) ?? c);", all("f((a ?? b) ?? c);").edits)).toEqual([
      ["drop-operand", "f(c);"],
      ["drop-operand", "f((b) ?? c);"],
      ["drop-operand", "f((a) ?? c);"],
      ["drop-operand", "f((a ?? b));"],
    ]);
    expect(all("x &&= y; x ||= y; x ??= y;").edits).toEqual([]);
  });

  it("moves each comparison to its boundary neighbour and flips !==", () => {
    const text = "f(a < b, a <= b, a > b, a >= b, a !== b);";
    expect(applied(text, all(text).edits)).toEqual([
      ["boundary", "f(a <= b, a <= b, a > b, a >= b, a !== b);"],
      ["boundary", "f(a < b, a < b, a > b, a >= b, a !== b);"],
      ["boundary", "f(a < b, a <= b, a >= b, a >= b, a !== b);"],
      ["boundary", "f(a < b, a <= b, a > b, a > b, a !== b);"],
      ["flip-equality", "f(a < b, a <= b, a > b, a >= b, a === b);"],
    ]);
  });

  it("adds and subtracts one from each number in a value position, in decimal, a negative in parentheses", () => {
    const text = "f(7, 0, 0x10, 1_000, 0.5, 2n, 0n);";
    expect(all(text).edits.map((edit) => [edit.note, edit.find, edit.replace])).toEqual([
      ["number+1", "7", "8"],
      ["number-1", "7", "6"],
      // "0" and "0," occur in later literals too, so the find widens right, then left.
      ["number+1", ", 0,", ", 1,"],
      ["number-1", ", 0,", ", (-1),"],
      ["number+1", "0x10", "17"],
      ["number-1", "0x10", "15"],
      ["number+1", "1_000", "1001"],
      ["number-1", "1_000", "999"],
      ["number+1", "0.5", "1.5"],
      ["number-1", "0.5", "(-0.5)"],
      ["number+1", "2n", "3n"],
      ["number-1", "2n", "1n"],
      ["number+1", "0n", "1n"],
      ["number-1", "0n", "(-1n)"],
    ]);
  });

  it("gives no number edit in a type, an enum or a property name", () => {
    const text =
      "type T = 1 | [2];\nlet t: 3 = 3 as 3;\nenum E { A = 4 }\nconst o = { 5: x };\nclass C { 6 = y; }\n";
    expect(all(text).edits.map((edit) => edit.find)).toEqual(["3 as", "3 as"]);
    // A declaration's initializer is a value, though its parent has a name.
    expect(all("const n = 5;").edits.map((edit) => edit.replace)).toEqual(["6", "4"]);
  });

  it("widens a find by whole tokens until it occurs once, and replaces only the break", () => {
    const text = "f(a >= b);\ng(a >= c);\n";
    expect(all(text).edits.filter((edit) => edit.note !== "move-guard")).toEqual([
      { file: "a.ts", find: ">= b", replace: "> b", expect: [], note: "boundary" },
      { file: "a.ts", find: ">= c", replace: "> c", expect: [], note: "boundary" },
    ]);
    // Right first, then left: " && b" and " && b;" occur twice, "c && b;" once.
    const last = suggestEdits("a.ts", "x = a && b;\ny = c && b;\n", new Set([2]));
    expect(last.edits.map((edit) => [edit.find, edit.replace])).toEqual([
      ["c && ", ""],
      ["c && b;", "c;"],
    ]);
  });

  it("widens right when nothing is left of the find, and left when nothing is right of it", () => {
    // "a && " and "a && b" occur twice, and nothing in the statement is left of them.
    const first = suggestEdits("a.ts", "a && b;\na && bc;\n", new Set([1]));
    expect(first.edits.map((edit) => [edit.find, edit.replace])[0]).toEqual(["a && b;", "b;"]);
    // ">=", ">= b", "a >= b", "a >= b;" and "+ a >= b;" occur twice; the statement ends at ";".
    const left = suggestEdits("a.ts", "x = k + a >= b;\ny = m + a >= b;\n", new Set([1]));
    expect(left.edits.map((edit) => [edit.find, edit.replace])).toEqual([["k + a >= b;", "k + a > b;"]]);
  });

  it("skips and counts a candidate whose whole statement occurs twice", () => {
    const text = "function f() {\n  return x >= y;\n}\nfunction g() {\n  return x >= y;\n}\n";
    expect(suggestEdits("a.ts", text, new Set([5]))).toEqual({ edits: [], skipped: 1 });
    // A class member is a statement's peer: two identical ones in two classes repeat too.
    const members = "class A {\n  x = a >= b;\n}\nclass B {\n  x = a >= b;\n}\n";
    expect(suggestEdits("a.ts", members, new Set([5]))).toEqual({ edits: [], skipped: 1 });
  });

  it("suggests nothing for a line the branch didn't add, and only the operands that start on an added line", () => {
    const text = "const ok =\n  a &&\n  b >= 1 &&\n  c;\n";
    expect(suggestEdits("a.ts", text, new Set([1]))).toEqual({ edits: [], skipped: 0 });
    const { edits } = suggestEdits("a.ts", text, new Set([3]));
    expect(applied(text, edits)).toEqual([
      ["drop-operand", "const ok =\n  a &&\n  c;\n"],
      ["boundary", "const ok =\n  a &&\n  b > 1 &&\n  c;\n"],
      ["number+1", "const ok =\n  a &&\n  b >= 2 &&\n  c;\n"],
      ["number-1", "const ok =\n  a &&\n  b >= 0 &&\n  c;\n"],
    ]);
  });

  it("parses .tsx as TSX, and a string passed to new RegExp gets nothing", () => {
    expect(
      suggestEdits("a.tsx", "const v = <b>{n > 1}</b>;\n", new Set([1])).edits.map((e) => e.note),
    ).toEqual(["boundary", "number+1", "number-1"]);
    // JSX text holds no comparison; read as TS, the same line has two.
    expect(suggestEdits("a.tsx", "const v = <p>a >= 1</p>;\n", new Set([1])).edits).toEqual([]);
    expect(suggestEdits("a.ts", "const v = <p>a >= 1</p>;\n", new Set([1])).edits).toHaveLength(4);
    expect(all('const r = new RegExp("(?=a)|b");').edits).toEqual([]);
  });

  it("removes each alternative of a group with one | next to it, and keeps an emptied pattern a regex", () => {
    const text = "const BOLD = /(\\*\\*|__).+?\\1/;";
    expect(applied(text, all(text).edits)).toEqual([
      ["regex-alternative", "const BOLD = /(__).+?\\1/;"],
      ["regex-alternative", "const BOLD = /(\\*\\*).+?\\1/;"],
    ]);
    expect(applied("r = /(?=a)/;", all("r = /(?=a)/;").edits)).toEqual([["regex-lookaround", "r = /(?:)/;"]]);
    // The v flag, read from the flags, makes a class nest.
    const nested = (flags: string) => `r = /[[]|]a|b/${flags};`;
    expect(applied(nested("v"), all(nested("v")).edits).map(([, text]) => text)).toEqual([
      nested("v").replace("[[]|]a|", ""),
      nested("v").replace("|b", ""),
    ]);
    expect(all(nested("")).edits).toHaveLength(3);
  });
});

describe("suggestEdits: the #265 kinds (B10-4)", () => {
  /** Each edit of `note` as the text it leaves. */
  const only = (text: string, note: string) =>
    applied(
      text,
      all(text).edits.filter((edit) => edit.note === note),
    ).map(([, out]) => out);

  it("passes undefined for each argument of handler(event, responseStream, context), lambda.ts's shape", () => {
    const text =
      "export const h = awslambda.streamifyResponse(async (event, responseStream, context) => {\n" +
      "  await handler(event, responseStream, context);\n});\n";
    expect(only(text, "pass-through")).toEqual([
      text.replace("handler(event,", "handler(undefined,"),
      text.replace("event, responseStream, context);", "event, undefined, context);"),
      text.replace("responseStream, context);", "responseStream, undefined);"),
    ]);
  });

  it("passes undefined for a parameter of any enclosing function, a destructured one and a property chain", () => {
    const text =
      "function f(options, { inputs }) {\n  return (context) => addContext(options.logger, context, inputs?.a.b);\n}\n";
    expect(
      all(text)
        .edits.filter((e) => e.note === "pass-through")
        .map((e) => [e.find, e.replace]),
    ).toEqual([
      ["options.logger", "undefined"],
      ["context,", "undefined,"],
      ["inputs?.a.b", "undefined"],
    ]);
  });

  it("gives no pass-through for a local, an element access, a call, this, a spread, or an unadded argument", () => {
    const text = 'function f(p, q) {\n  const l = 1;\n  g(l, p["x"], p.x(), this, ...q, h);\n}\n';
    expect(only(text, "pass-through")).toEqual([]);
    const later = "function f(p) {\n  g(1,\n    p);\n}\n";
    expect(suggestEdits("a.ts", later, new Set([2])).edits.map((e) => e.note)).toEqual([
      "number+1",
      "number-1",
    ]);
    expect(only("function f(p) {\n  return new X(p);\n}\n", "pass-through")).toEqual([
      "function f(p) {\n  return new X(undefined);\n}\n",
    ]);
  });

  it("negates a true or false argument of a call or new, and not one in an object or behind !", () => {
    const text = "f(true, { recursive: true }, !false);\nnew G(false);\n";
    expect(only(text, "flip-argument")).toEqual([
      "f(false, { recursive: true }, !false);\nnew G(false);\n",
      "f(true, { recursive: true }, !false);\nnew G(true);\n",
    ]);
  });

  it("appends [extra] to a thrown Error's string or template message, and to nothing else", () => {
    const text =
      'function f(x) {\n  if (x) throw new Error("bad x", { cause: x });\n  throw new Error(`bad ${x}`);\n}\n' +
      'throw new ChatProtocolError("sub");\nthrow Error("no new");\nconst e = new Error("not thrown");\n' +
      'throw new Error(message);\nlogError("logged");\n';
    expect(only(text, "extend-message")).toEqual([
      text.replace('"bad x"', '"bad x [extra]"'),
      text.replace("`bad ${x}`", "`bad ${x} [extra]`"),
    ]);
  });

  it("swaps a discarded call or await statement with the next statement of its block, a return included", () => {
    const text = "async function f(env) {\n  assertWritableEnv(env);\n  await run();\n  return 1;\n}\n";
    expect(only(text, "move-guard")).toEqual([
      "async function f(env) {\n  await run();\n  assertWritableEnv(env);\n  return 1;\n}\n",
      "async function f(env) {\n  assertWritableEnv(env);\n  return 1;\n  await run();\n}\n",
    ]);
  });

  it("moves a guard at a file's top level and in a case clause, and not the last statement or across a declaration", () => {
    expect(only("setup();\nconst a = 1;\n", "move-guard")).toEqual(["const a = 1;\nsetup();\n"]);
    const clause = "switch (k) {\n  case 1:\n    new Check(k);\n    x = 1;\n    break;\n}\n";
    expect(only(clause, "move-guard")).toEqual([
      "switch (k) {\n  case 1:\n    x = 1;\n    new Check(k);\n    break;\n}\n",
    ]);
    const rest = "g();\nfunction a() {}\nh();\nclass B {}\ni();\ninterface C {}\nj();\ntype D = 1;\nk();\n";
    expect(only(rest, "move-guard")).toEqual([]);
    expect(only("const v = f();\nx = g();\nh;\n", "move-guard")).toEqual([]);
  });

  it("widens a move-guard find within its statement list, and moves only a guard whose first line is added", () => {
    // "check();\n  go();" occurs twice, and with the block's "}" after it too; widening within the block then
    // reaches the statement before it.
    const text =
      "function f() {\n  a();\n  check();\n  go();\n}\nfunction g() {\n  b();\n  check();\n  go();\n}\n";
    const edits = suggestEdits("a.ts", text, new Set([3])).edits;
    expect(edits.map((e) => [e.note, e.find, e.replace])).toEqual([
      ["move-guard", "a();\n  check();\n  go();\n}", "a();\n  go();\n  check();\n}"],
    ]);
    expect(suggestEdits("a.ts", text, new Set([4])).edits).toEqual([]);
  });
});

describe("regexParts", () => {
  const removals = (pattern: string, v = false) => {
    const { lookarounds, alternatives } = regexParts(pattern, v);
    const cut = ({ start, end }: { start: number; end: number }) =>
      pattern.slice(0, start) + pattern.slice(end);
    return { lookarounds: lookarounds.map(cut), alternatives: alternatives.map(cut) };
  };

  it("reads alternatives at any depth, the whole pattern's too, and an empty alternative", () => {
    expect(removals("a|(b|c)|(d|)")).toEqual({
      lookarounds: [],
      alternatives: [
        "a|(c)|(d|)",
        "a|(b)|(d|)",
        "a|(b|c)|()",
        "a|(b|c)|(d)",
        "(b|c)|(d|)",
        "a|(d|)",
        "a|(b|c)",
      ],
    });
  });

  it("reads the alternatives inside a lookaround, and a | in the innermost open group", () => {
    expect(removals("(?=a|b)c")).toEqual({ lookarounds: ["c"], alternatives: ["(?=b)c", "(?=a)c"] });
    expect(removals("(x(b|c))").alternatives).toEqual(["(x(c))", "(x(b))"]);
    expect(removals("a\\|b")).toEqual({ lookarounds: [], alternatives: [] });
  });

  it("removes a nested lookaround on its own, and reads a named group as a group", () => {
    expect(removals("(?=a(?!b))(?<n>c)(?<=d)(?<!e)")).toEqual({
      lookarounds: [
        "(?=a)(?<n>c)(?<=d)(?<!e)",
        "(?<n>c)(?<=d)(?<!e)",
        "(?=a(?!b))(?<n>c)(?<!e)",
        "(?=a(?!b))(?<n>c)(?<=d)",
      ],
      alternatives: [],
    });
  });

  it("treats escapes and characters in a class as text, nested classes with the v flag", () => {
    expect(removals("\\(\\|[(|][^)]x")).toEqual({ lookarounds: [], alternatives: [] });
    expect(removals("[[(]|]a|b", true)).toEqual({ lookarounds: [], alternatives: ["b", "[[(]|]a"] });
    // Without v, the first `]` ends the class, so the `|` after it splits the pattern.
    expect(removals("[[(]|b").alternatives).toEqual(["b", "[[(]"]);
    // An unmatched `)` (a syntax error in the pattern) is ignored.
    expect(removals("a)|b").alternatives).toEqual(["b", "a)"]);
  });
});

/** Two identical statements, whose comparisons can't get a unique find. */
const DUPLICATES =
  "export function f(x: number, y: number) {\n  return x >= y;\n}\nexport function g(x: number, y: number) {\n  return x >= y;\n}\n";

describe("mutate --suggest", () => {
  let repo: TestRepo;
  let out: string[];
  let errors: string[];
  /** Writes what `main` printed on stdout to an edits file, and returns its path. */
  const writeOut = () => {
    writeFileSync(join(repo.dir, "edits.json"), out.join("\n"));
    return join(repo.dir, "edits.json");
  };
  const deps = (env: Record<string, string | undefined> = {}) => ({
    cwd: repo.dir,
    env,
    ...logsTo(out, errors),
  });

  beforeEach(() => {
    repo = gitRepo("mutate-suggest-");
    repo.write("scripts/a.ts", "export const a = (x: number) => x > 1;\n");
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feature");
    repo.write(
      "scripts/a.ts",
      "export const a = (x: number) => x > 1;\nexport const b = (x: number) => x === 2;\n",
    );
    repo.write("scripts/a.test.ts", "expect(a(2) >= 1);\n");
    // A src/test/ helper needs no evidence, so it gets no edits.
    repo.write("apps/web/src/test/setup.ts", "export const h = 3;\n");
    repo.write("docs/notes.ts", "export const n = 4;\n");
    repo.commit("feature");
    out = [];
    errors = [];
  });
  afterEach(() => repo.remove());

  it("prints an edits file for the added source lines that the runner reads, and counts them on stderr", async () => {
    expect(await mutate(["--suggest", "--base", "main"], deps())).toBe(0);
    expect(out[0]?.startsWith('[\n  {\n    "file": "scripts/a.ts",\n')).toBe(true);
    writeFileSync(join(repo.dir, "edits.json"), out.join("\n"));
    expect(readEdits(join(repo.dir, "edits.json"))).toEqual([
      { id: "1", file: "scripts/a.ts", find: "===", replace: "!==", expect: [], note: "flip-equality" },
      { id: "2", file: "scripts/a.ts", find: "2", replace: "3", expect: [], note: "number+1" },
      { id: "3", file: "scripts/a.ts", find: "2", replace: "1", expect: [], note: "number-1" },
    ]);
    expect(errors).toEqual([
      "mutate --suggest: 3 edits since main; skipped 0 whose statement occurs more than once, and 0 in files with " +
        "uncommitted changes. Fill in each edit's expect.",
    ]);
  });

  it("suggests edits for helpers in scripts/test/ and apps/*/e2e/, and none for Playwright specs (#265, B10-3)", async () => {
    repo.write("scripts/test/helper.ts", "export const h = 5;\n");
    repo.write("apps/web/e2e/support/helper.ts", "export const s = 6;\n");
    repo.write("apps/web/e2e/01-login.e2e.ts", "export const l = 7;\n");
    repo.write("apps/web/e2e/fr010.greeting.ts", "export const g = 8;\n");
    repo.commit("helpers and specs");
    expect(await mutate(["--suggest", "--base", "main"], deps())).toBe(0);
    expect(readEdits(writeOut()).map((edit) => [edit.file, edit.find])).toEqual([
      ["apps/web/e2e/support/helper.ts", "6"],
      ["apps/web/e2e/support/helper.ts", "6"],
      ["scripts/a.ts", "==="],
      ["scripts/a.ts", "2"],
      ["scripts/a.ts", "2"],
      ["scripts/test/helper.ts", "5"],
      ["scripts/test/helper.ts", "5"],
    ]);
  });

  it("counts on stderr the candidates whose whole statement occurs twice", async () => {
    repo.write("scripts/d.ts", DUPLICATES);
    repo.commit("two identical statements");
    expect(await mutate(["--suggest", "--base", "main"], deps())).toBe(0);
    expect(readEdits(writeOut()).map((edit) => edit.file)).toEqual([
      "scripts/a.ts",
      "scripts/a.ts",
      "scripts/a.ts",
    ]);
    expect(errors).toEqual([
      "mutate --suggest: 3 edits since main; skipped 2 whose statement occurs more than once, and 0 in files with " +
        "uncommitted changes. Fill in each edit's expect.",
    ]);
  });

  it("takes the base from COVERAGE_BASE, then origin/main, and --base over both", async () => {
    expect(await mutate(["--suggest"], deps({ COVERAGE_BASE: "main" }))).toBe(0);
    expect(errors[0]).toContain("3 edits since main");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(await mutate(["--suggest"], deps({ COVERAGE_BASE: "" }))).toBe(0);
    expect(out.at(-1)).toBe("[]");
    expect(errors[1]).toContain("0 edits since origin/main");
    expect(await mutate(["--suggest", "--base", "main"], deps({ COVERAGE_BASE: "origin/main" }))).toBe(0);
    expect(errors[2]).toContain("3 edits since main");
  });

  it("names a file with uncommitted changes and skips its candidates, and not one with none", async () => {
    repo.write("scripts/b.ts", "export const b = (x: string) => x;\n");
    // One edit and, in the two identical statements, two skipped candidates.
    repo.write("scripts/c.ts", "export const c = (x: string, y: string) => x === y;\n" + DUPLICATES);
    repo.commit("two more files");
    for (const file of ["a", "b", "c"]) repo.write(`scripts/${file}.ts`, "// edited\n");
    expect(await mutate(["--suggest", "--base", "main"], deps())).toBe(0);
    expect(out).toEqual(["[]"]);
    expect(errors).toEqual([
      "mutate --suggest: scripts/a.ts has uncommitted changes; skipped its 3 candidates.",
      "mutate --suggest: scripts/c.ts has uncommitted changes; skipped its 3 candidates.",
      "mutate --suggest: 0 edits since main; skipped 0 whose statement occurs more than once, and 6 in files with " +
        "uncommitted changes. Fill in each edit's expect.",
    ]);
  });

  it("exits 2 for a run's arguments with --suggest, an unknown option, or a base with no merge base", async () => {
    for (const argv of [
      ["--suggest", "edits.json"],
      ["--suggest", "--", "true"],
      ["--suggest", "--"],
      ["--suggest", "--markdown"],
      ["--suggest", "--json", "x.json"],
      ["--suggest", "--only", "1"],
      ["--suggest", "--timeout", "5"],
      ["--suggest", "--bogus"],
    ])
      expect(await mutate(argv, deps())).toBe(2);
    expect(errors).toHaveLength(8);
    expect(
      errors.every((line) => line.includes("usage: mutate") && line.includes("--suggest [--base <ref>]")),
    ).toBe(true);
    // The suggester itself refuses a test command: `mutate` handed it the arguments.
    expect(errors[1]).toMatch(/^--suggest takes no test command\. usage: mutate/);
    expect(await mutate(["--suggest", "--base", "nope"], deps())).toBe(2);
    expect(errors[8]).toBe("mutate --suggest: no merge base with nope (fetch it, or pass --base <ref>).");
    expect(out).toEqual([]);
  });

  it("logs to the console by default", async () => {
    await withConsole(async (log, error) => {
      // No env: the process's, whose COVERAGE_BASE (if any) --base overrides.
      expect(await mutate(["--suggest", "--base", "main"], { cwd: repo.dir })).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"note": "flip-equality"'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("3 edits since main"));
    });
  });
});
