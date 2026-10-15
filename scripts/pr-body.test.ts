/**
 * scripts/pr-body.ts: the title rule against merged PR titles and broken ones, the `Refs`/closing-keyword rule and the
 * decisions-section rule against hand-written bodies (the PR template's own section among them), and `main`'s exit codes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decisionItems, main, problems, refsAndCloses, titleOk } from "./pr-body";
import { logsTo, withConsole } from "./test/git-repo";

/** `.github/pull_request_template.md`, whose decisions section must pass. */
const TEMPLATE = readFileSync(join(import.meta.dirname, "..", ".github", "pull_request_template.md"), "utf8");

/** `<keyword> #<n>`. */
const closing = (keyword: string, n: string) => `${keyword} #${n}`;

describe("titleOk", () => {
  it.each([
    "eval: M3 model matrix picks sonnet-4.6 at effort high; ADR-002 amended (#37)",
    "fix(scripts): deploy-web.sh refuses a build without the env's Identity Pool ID (#232)",
    "fix(scripts): mutate's tests stop SIGKILLing a pid read from checker.pid (#215)",
    "chore(scripts): one shared YAML-as-text reader for the template and workflow tests (#157)",
    "test(scripts): shell harness and tests for deploy.sh and teardown.sh (#137)",
    "feat(scripts): trace.ts prints a conversation's turn traces (#38, part 1 of 2)",
    "test(web): Playwright E2E journeys against the e2e env, FR-010 measurement, manual checklist (#40)",
    "feat(api): Powertools logs, per-turn metrics, X-Ray and the chat dashboard (#38)",
    "feat(web,api): a scope with a comma (#9)",
    "docs: a summary (with parentheses) before the number (#9)",
  ])("passes the merged title %s", (title) => {
    expect(titleOk(title)).toBe(true);
  });

  it.each([
    "[M3] Process batch 10: a PR-body check, gated test helpers, new --suggest kinds, and stale-row evidence",
    "refactor(tools): an unknown type (#77)",
    "Feat(api): an uppercase type (#77)",
    "feat(api)!: a breaking change (#77)",
    "feat(): an empty scope (#77)",
    "feat(a(b)): a scope with parentheses (#77)",
    "chore(deps-dev): Bump source-map-js from 1.2.1 to 1.2.2",
    "feat(api): no issue number (#)",
    "feat(api): a number with digits after it (#38a)",
    "feat(api): text after the number group (#38) and more",
    "feat(api):no space after the colon (#38)",
    "feat(api): (#38)",
    "feat(api):  (#38)",
    "feat(api): no space before the group(#38)",
    "xfeat(api): a prefix before the type (#38)",
  ])("fails %s", (title) => {
    expect(titleOk(title)).toBe(false);
  });
});

describe("refsAndCloses", () => {
  it.each(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"])(
    "finds Refs #38 beside %s #38, in any case and with a colon",
    (keyword) => {
      expect(refsAndCloses(`Refs #38\n\nthe second PR, which ${closing(keyword, "38")}`)).toEqual(["38"]);
      expect(refsAndCloses(`refs: #38\n${closing(`${keyword.toUpperCase()}:`, "38")}`)).toEqual(["38"]);
    },
  );

  it("reads code spans, fenced blocks and HTML comments, and a line break after the keyword", () => {
    expect(refsAndCloses(`Refs #38\n\`${closing("closes", "38")}\``)).toEqual(["38"]);
    expect(refsAndCloses(`Refs #38\n\`\`\`\n${closing("fixes", "38")}\n\`\`\``)).toEqual(["38"]);
    expect(refsAndCloses(`Refs #38\n<!-- ${closing("resolves", "38")} -->`)).toEqual(["38"]);
    expect(refsAndCloses("Refs #38\nCloses\n#38")).toEqual(["38"]);
    expect(refsAndCloses(`Refs #38 #40\nRefs #38\n${closing("Closes", "38")}`)).toEqual(["38"]);
  });

  it("passes Refs or a closing keyword alone, two numbers, a longer number, a word ending in a keyword, and a URL", () => {
    expect(refsAndCloses("Refs #38")).toEqual([]);
    expect(refsAndCloses(closing("Closes", "38"))).toEqual([]);
    expect(refsAndCloses(`Refs #38\n${closing("Closes", "40")}`)).toEqual([]);
    expect(refsAndCloses(`Refs #38\n${closing("Closes", "380")}`)).toEqual([]);
    expect(refsAndCloses(`Refs #380\n${closing("Closes", "38")}`)).toEqual([]);
    expect(refsAndCloses("Refs #38\nprefixes #38, unclosed #38")).toEqual([]);
    expect(refsAndCloses("Refs #38\nCloses https://github.com/o/r/issues/38, closes o/r#38")).toEqual([]);
    expect(refsAndCloses("xrefs #38\nCloses #38")).toEqual([]);
  });
});

describe("decisionItems", () => {
  const body = (...section: string[]) =>
    ["## Summary", "", "- a list elsewhere", "", "## Decisions the spec left open", "", ...section].join(
      "\n",
    );

  it("passes the PR template's own section, None, a link, prose and a body without the section", () => {
    expect(decisionItems(TEMPLATE)).toEqual([]);
    expect(decisionItems(body("None."))).toEqual([]);
    expect(decisionItems(body("None"))).toEqual([]);
    expect(decisionItems(body("See [the entry](docs/journal/x.md#why-we-chose)."))).toEqual([]);
    expect(decisionItems(body("We chose a and b; the entry lists both."))).toEqual([]);
    expect(decisionItems("- a list\n## Decisions\n- another")).toEqual([]);
  });

  it("reads each list marker, indented or not, as an item, None included", () => {
    expect(decisionItems(body("- None", "* b", "+ c", "  1. d", "12) e", "-x", "1.f"))).toEqual([
      "- None",
      "* b",
      "+ c",
      "1. d",
      "12) e",
    ]);
  });

  it("ends the section at **Departs from or the next ## heading, not at a ### subheading", () => {
    // An item on the line right after the heading, and the section's end right after it.
    expect(decisionItems("## Decisions the spec left open\n- a\n**Departs from x\n- b")).toEqual(["- a"]);
    expect(decisionItems(body("None.", "**Departs from or questions an owner decision:**", "- a"))).toEqual(
      [],
    );
    expect(decisionItems(body("None.", "## Docs", "- [ ] ADR"))).toEqual([]);
    expect(decisionItems(body("### More", "- a"))).toEqual(["- a"]);
  });

  it("skips lines in an HTML comment, one line or several, and in a fenced block, CRLF bodies included", () => {
    const section = ["<!-- - a -->", "<!--", "- b", "-->", "```", "- c", "```", "~~~", "* d", "~~~", "- e"];
    expect(decisionItems(body(...section))).toEqual(["- e"]);
    expect(decisionItems(body(...section).replaceAll("\n", "\r\n"))).toEqual(["- e"]);
    expect(decisionItems(body("<!-- unclosed", "- f"))).toEqual([]);
  });
});

describe("problems", () => {
  it("names each problem, and none for a good title and body", () => {
    const body = `Refs #38\n${closing("closes", "38")}\n\n## Decisions the spec left open\n\n- one\n- two\n`;
    expect(problems("[M3] an issue title", body)).toEqual([
      expect.stringMatching(
        /^title: "\[M3\] an issue title" isn't .*feat, fix, infra, spike, docs, eval, chore, test/,
      ),
      expect.stringMatching(/^body: says Refs #38 and also has a closing keyword right before #38/),
      expect.stringMatching(/^body: "## Decisions the spec left open" holds a list \(- one \/ - two\)/),
    ]);
    expect(problems("chore(process): a summary (#265)", "Closes #265\n")).toEqual([]);
    expect(problems("fix(x): y (#1)", "## Decisions the spec left open\n- one")).toEqual([
      'body: "## Decisions the spec left open" holds a list (- one); list the decisions once, in the journal ' +
        'entry\'s "Why we chose", and link it there.',
    ]);
  });
});

describe("main", () => {
  const run = (vars: Record<string, string | undefined>, argv: string[] = []) => {
    const out: string[] = [];
    const errors: string[] = [];
    return { code: main(argv, vars, logsTo(out, errors)), out, errors };
  };

  it("exits 0 for a good title and an unset or empty body", () => {
    expect(run({ PR_TITLE: "fix(x): y (#1)" })).toEqual({
      code: 0,
      out: ["pr-body: the title and body pass."],
      errors: [],
    });
    expect(run({ PR_TITLE: "fix(x): y (#1)", PR_BODY: "" }).code).toBe(0);
  });

  it("exits 1 naming each problem", () => {
    const { code, out, errors } = run({ PR_TITLE: "bad", PR_BODY: `Refs #2 ${closing("fixes", "2")}` });
    expect(code).toBe(1);
    expect(out[0]).toBe("The PR's title or body has 2 problem(s):");
    expect(out.slice(1).map((line) => line.slice(0, 6))).toEqual(["title:", "body: "]);
    expect(errors).toEqual([expect.stringContaining("pr-body: fix the title or body")]);
    expect(run({ PR_TITLE: "bad" })).toMatchObject({
      code: 1,
      out: ["The PR's title or body has 1 problem(s):", expect.any(String)],
    });
  });

  it("exits 2 without PR_TITLE, or for an argument", () => {
    expect(run({ PR_BODY: "x" })).toEqual({
      code: 2,
      out: [],
      errors: ["usage: pr-body (PR_TITLE and PR_BODY in the environment) (PR_TITLE isn't set)"],
    });
    // An argument is reported first, with or without PR_TITLE.
    expect(run({}, ["--bogus"]).errors).toEqual([expect.stringContaining("'--bogus'")]);
    expect(run({ PR_TITLE: "fix(x): y (#1)" }, ["--bogus"])).toMatchObject({
      code: 2,
      errors: [expect.stringContaining("usage: pr-body")],
    });
  });

  it("logs to the console by default", async () => {
    await withConsole((log, error) => {
      expect(main([], { PR_TITLE: "fix(x): y (#1)" })).toBe(0);
      expect(log).toHaveBeenCalledWith("pr-body: the title and body pass.");
      expect(main([], {})).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: pr-body"));
    });
  });
});
