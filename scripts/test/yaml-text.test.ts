/**
 * scripts/test/yaml-text.ts (#157): the YAML-as-text reader the template and workflow tests share. Each case of
 * r1/Q-2 (b)'s block and item ends has its own test, named for the case.
 */
import { describe, expect, it } from "vitest";

import {
  block,
  bodyLines,
  childBlocks,
  children,
  credentialsLines,
  credentialsOf,
  entries,
  indentOf,
  isCredentialsStep,
  items,
  member,
  root,
  scalar,
  stepsOf,
  structuralLines,
  text,
} from "./yaml-text";

const WORKFLOW = `name: Example

on:
  pull_request:

jobs:
  gate:
    permissions:
      contents: read
    steps:
      - name: Plan
        id: plan
        run: npx tsx plan.ts # decides
      # Introduces the next step, so it isn't part of Plan.
      - uses: aws-actions/configure-aws-credentials@abc123 # v6
        if: steps.plan.outputs.run == 'true'
        with:
          role-to-assume: \${{ secrets.ROLE }}
          mask-aws-account-id: true
      - name: Smoke
        if: "steps.plan.outputs.run == 'true'"
        run: |
          # shellcheck disable=SC2086 # a comment inside the body is body text
          npm run evals -- $SMOKE

          echo done
          # a last body line that looks like a comment
      - name: Credentials, name first
        uses: aws-actions/configure-aws-credentials@abc123

  other:
    steps:
      - run: echo other
`.split("\n");

describe("indentOf", () => {
  it("counts the leading spaces", () => {
    expect(indentOf("    key: value")).toBe(4);
    expect(indentOf("key:")).toBe(0);
  });
});

describe("block", () => {
  it("is the header and every deeper line after it, up to the next line at its indent", () => {
    expect(block(/^ {4}permissions:$/, WORKFLOW)).toEqual(["    permissions:", "      contents: read"]);
  });

  it("throws on a header no line matches", () => {
    expect(() => block(/^nope:$/, WORKFLOW)).toThrow("no line matches /^nope:$/");
  });

  it("throws on a header that matches more than one line, nested or not", () => {
    expect(() => block(/^\s+steps:$/, WORKFLOW)).toThrow("2 lines match");
    expect(() => block(/^\s+(- )?uses: aws-actions\//, WORKFLOW)).toThrow("2 lines match");
  });

  it("finds a repeated header once the search is narrowed to an enclosing block", () => {
    expect(block(/^\s+steps:$/, block(/^ {2}other:$/, WORKFLOW))).toEqual([
      "    steps:",
      "      - run: echo other",
    ]);
  });

  it("matches no comment line and no block-scalar text", () => {
    expect(() => block(/Introduces the next step/, WORKFLOW)).toThrow("no line matches");
    expect(() => block(/npm run evals/, WORKFLOW)).toThrow("no line matches");
  });

  it("(1) goes on past a comment at or left of the header's indent when deeper lines follow", () => {
    const lines = ["a:", "  b:", "# a comment at the left edge", "    c: 1", "  d: 2"];
    expect(block(/^ {2}b:$/, lines)).toEqual(["  b:", "# a comment at the left edge", "    c: 1"]);
  });

  it("(2) leaves out the comment just above the next item at the dash indent", () => {
    expect(block(/^\s+- name: Plan$/, WORKFLOW)).toEqual([
      "      - name: Plan",
      "        id: plan",
      "        run: npx tsx plan.ts # decides",
    ]);
  });

  it("(3) keeps a `#` line inside a `run: |` body, in its step and in its body", () => {
    const smoke = block(/^\s+- name: Smoke$/, WORKFLOW);
    expect(smoke).toContain("          # shellcheck disable=SC2086 # a comment inside the body is body text");
    expect(smoke.at(-1)).toBe("          # a last body line that looks like a comment");
  });

  it("(4) leaves out the trailing blank lines", () => {
    expect(block(/^\s+- name: Credentials, name first$/, WORKFLOW)).toEqual([
      "      - name: Credentials, name first",
      "        uses: aws-actions/configure-aws-credentials@abc123",
    ]);
  });

  it("(5) runs the last block in the input to its end", () => {
    expect(block(/^ {2}other:$/, WORKFLOW)).toEqual(["  other:", "    steps:", "      - run: echo other"]);
  });
});

describe("items", () => {
  const steps = items(block(/^\s+steps:$/, block(/^ {2}gate:$/, WORKFLOW)));

  it("finds each item whole, whether it starts `- name:` or `- uses:`", () => {
    expect(steps.map((s) => s[0]?.trim())).toEqual([
      "- name: Plan",
      "- uses: aws-actions/configure-aws-credentials@abc123 # v6",
      "- name: Smoke",
      "- name: Credentials, name first",
    ]);
    expect(steps[1]).toHaveLength(5);
    expect(steps[3]).toEqual([
      "      - name: Credentials, name first",
      "        uses: aws-actions/configure-aws-credentials@abc123",
    ]);
  });

  it("ends an item at the next `- ` line at its indent, without the comment that introduces it", () => {
    expect(steps[0]).toHaveLength(3);
    expect(steps[2]?.some((l) => l.includes("- name: Credentials"))).toBe(false);
  });

  it("keeps an item whole when it holds a list deeper than its dash", () => {
    const statements = [
      "Statement:",
      "  - Effect: Allow",
      "    Action:",
      "      - sts:AssumeRole",
      "      - sts:TagSession",
      "  - Effect: Deny",
    ];
    expect(items(statements)).toEqual([statements.slice(1, 5), statements.slice(5)]);
  });

  it("throws when the header's first child isn't a list item", () => {
    expect(() => items(block(/^ {4}permissions:$/, WORKFLOW))).toThrow("no list items under");
  });
});

describe("entries", () => {
  const steps = items(block(/^\s+steps:$/, block(/^ {2}gate:$/, WORKFLOW)));

  it("reads a block's direct entries, not its grandchildren", () => {
    expect(entries(block(/^ {2}gate:$/, WORKFLOW))).toEqual({});
    expect(entries(block(/^\s+with:$/, steps[1] ?? []))).toEqual({
      "role-to-assume": "${{ secrets.ROLE }}",
      "mask-aws-account-id": "true",
    });
  });

  it("reads an item's entries, its first key included, without a trailing comment or quotes", () => {
    expect(entries(steps[0] ?? [])).toEqual({ name: "Plan", id: "plan", run: "npx tsx plan.ts" });
    expect(entries(steps[1] ?? [])).toEqual({
      uses: "aws-actions/configure-aws-credentials@abc123",
      if: "steps.plan.outputs.run == 'true'",
    });
    expect(entries(steps[2] ?? []).if).toBe("steps.plan.outputs.run == 'true'");
  });

  it("reads a block scalar's value as its dedented body, `#` lines included", () => {
    expect(entries(steps[2] ?? []).run).toBe(
      [
        "# shellcheck disable=SC2086 # a comment inside the body is body text",
        "npm run evals -- $SMOKE",
        "",
        "echo done",
        "# a last body line that looks like a comment",
        "",
      ].join("\n"),
    );
  });
});

describe("entries, other forms", () => {
  it("reads `key: # comment` as a block header with no entry, and unquotes keys and single-quoted values", () => {
    const lines = ["perms:", "  a: # why", "    b: 1", '  "id-token": write', "  c: 'x # y' # z"];
    expect(entries(lines)).toEqual({ "id-token": "write", c: "x # y" });
  });

  it("measures a `- run: |` body from the key, past the dash, so the item's next key isn't body text", () => {
    const step = ["- run: |", "    echo hi", "  name: After"];
    expect(entries(step)).toEqual({ run: "echo hi\n", name: "After" });
    expect(structuralLines(step)).toEqual(["- run: |", "  name: After"]);
  });
});

describe("member", () => {
  const job = [
    "  a:",
    '    flow: { contents: read, "id-token": write }',
    "    inline: write-all # everything",
    "    nested: # least privilege",
    "      id-token: write",
  ];

  it("reads a flow map, a one-line value and a block as their values, and an absent key as undefined", () => {
    expect(member(job, "flow")).toEqual({ contents: "read", "id-token": "write" });
    expect(member(job, "inline")).toBe("write-all");
    expect(member(job, "nested")).toEqual({ "id-token": "write" });
    expect(member(job, "missing")).toBeUndefined();
  });

  it("reads a whole file's top level through root", () => {
    expect(member(root(WORKFLOW), "name")).toBe("Example");
    expect(member(root(WORKFLOW), "on")).toEqual({});
  });
});

describe("childBlocks", () => {
  it("gives each direct child of a header as its own block", () => {
    const jobs = childBlocks(block(/^jobs:$/, WORKFLOW));
    expect(jobs.map((j) => j[0])).toEqual(["  gate:", "  other:"]);
    expect(jobs[1]).toEqual(block(/^ {2}other:$/, WORKFLOW));
  });
});

describe("structuralLines", () => {
  it("drops blank lines, comments and block-scalar text", () => {
    const lines = ["a:", "", "  # note", "  run: |", "    # body", "  b: 1"];
    expect(structuralLines(lines)).toEqual(["a:", "  run: |", "  b: 1"]);
  });
});

describe("children", () => {
  it("is the structural lines directly under the header", () => {
    expect(children(block(/^jobs:$/, WORKFLOW))).toEqual(["  gate:", "  other:"]);
    expect(children(block(/^on:$/, WORKFLOW))).toEqual(["  pull_request:"]);
  });
});

describe("scalar", () => {
  it("dedents a block scalar's body to its least-indented line, keeping deeper indents", () => {
    const lines = [
      "  Fn:",
      "    Code: |",
      "      function f() {",
      "        return 1;",
      "      }",
      "    Other: x",
    ];
    expect(scalar(block(/^\s+Code: \|$/, lines))).toBe("function f() {\n  return 1;\n}\n");
  });

  it("throws on a header that isn't a block scalar", () => {
    expect(() => scalar(block(/^ {4}permissions:$/, WORKFLOW))).toThrow("not a block scalar");
  });
});

describe("bodyLines", () => {
  it("keeps a block scalar's `#` lines", () => {
    const lines = ["Fn:", "  Code: |", "    # kept", "    x();", "  # dropped"];
    expect(bodyLines(lines)).toEqual(["  Code: |", "    # kept", "    x();"]);
  });

  it("drops comment and blank lines and dedents to the header", () => {
    const lines = ["  Policies:", "    - Version: 1", "", "      # why", "      Statement: []", "  Next:"];
    expect(bodyLines(block(/^ {2}Policies:$/, lines))).toEqual(["  - Version: 1", "    Statement: []"]);
  });
});

describe("text", () => {
  it("joins the lines and ends with a newline", () => {
    expect(text(["a:", "  b: 1"])).toBe("a:\n  b: 1\n");
  });
});

describe("isCredentialsStep", () => {
  it("recognises the credentials step in either form, and nothing else", () => {
    const steps = items(block(/^\s+steps:$/, block(/^ {2}gate:$/, WORKFLOW)));
    expect(steps.map(isCredentialsStep)).toEqual([false, true, false, true]);
  });
});

describe("credentialsOf", () => {
  it("counts a job's credentials lines and steps, and reads the first step's with:", () => {
    const gate = credentialsOf(block(/^ {2}gate:$/, WORKFLOW));
    expect([gate.lines, gate.steps.length]).toEqual([2, 2]);
    expect(gate.settings).toEqual({ "role-to-assume": "${{ secrets.ROLE }}", "mask-aws-account-id": "true" });
    expect(credentialsOf(block(/^ {2}other:$/, WORKFLOW))).toEqual({ lines: 0, steps: [], settings: {} });
  });
});

describe("stepsOf", () => {
  it("is the items of a job's steps:", () => {
    const gate = block(/^ {2}gate:$/, WORKFLOW);
    expect(stepsOf(gate)).toEqual(items(block(/^\s+steps:$/, gate)));
    expect(stepsOf(gate)).toHaveLength(4);
  });
});

describe("credentialsLines", () => {
  it("finds the action as a uses: value in either step form, quoted or not, and not in a comment", () => {
    const lines = [
      "      # uses: aws-actions/configure-aws-credentials@abc",
      '      - uses: "aws-actions/configure-aws-credentials@abc"',
      "      - name: x",
      "        uses: 'aws-actions/configure-aws-credentials@abc'",
      "      - uses: actions/checkout@abc",
    ];
    expect(credentialsLines(lines)).toEqual([lines[1], lines[3]]);
  });
});
