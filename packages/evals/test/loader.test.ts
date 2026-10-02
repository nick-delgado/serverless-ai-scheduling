/**
 * Negative tests for the loader's file checks and the schema refinements: a broken scenario file must be
 * reported, never loaded or silently dropped.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { L1Case, loadScenarios, Scenario, ScenarioLoadError, SCENARIOS_DIR } from "../src";
import { l1Case, scenario } from "./helpers";

const GOOD = join(SCENARIOS_DIR, "book", "book-derm-next-week-afternoon.yaml");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A scenarios dir holding `files` (`<folder>/<name>.yaml` → source path or YAML text). */
function scenariosDir(files: Record<string, { from: string } | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-loader-"));
  dirs.push(dir);
  for (const [path, source] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    if (typeof source === "string") writeFileSync(target, source);
    else copyFileSync(source.from, target);
  }
  return dir;
}

function problems(dir: string): readonly string[] {
  try {
    loadScenarios(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(ScenarioLoadError);
    return (error as ScenarioLoadError).problems;
  }
  throw new Error("expected a ScenarioLoadError");
}

describe("loader", () => {
  it("loads a valid file", () => {
    const dir = scenariosDir({ "book/book-derm-next-week-afternoon.yaml": { from: GOOD } });
    expect(loadScenarios(dir).scenarios.map((s) => s.id)).toEqual(["book-derm-next-week-afternoon"]);
  });

  it("rejects an id that doesn't match the file name", () => {
    const dir = scenariosDir({ "book/renamed.yaml": { from: GOOD } });
    expect(problems(dir)).toEqual([
      'book/renamed.yaml: id "book-derm-next-week-afternoon" must match the file name',
    ]);
  });

  it("rejects a category that doesn't match the folder", () => {
    const dir = scenariosDir({ "escalate/book-derm-next-week-afternoon.yaml": { from: GOOD } });
    expect(problems(dir)).toEqual([
      'escalate/book-derm-next-week-afternoon.yaml: category "book" must match the folder',
    ]);
  });

  it("rejects a duplicate id", () => {
    const dir = scenariosDir({
      "book/book-derm-next-week-afternoon.yaml": { from: GOOD },
      "escalate/book-derm-next-week-afternoon.yaml": { from: GOOD },
    });
    expect(problems(dir)).toContainEqual(
      'escalate/book-derm-next-week-afternoon.yaml: duplicate id "book-derm-next-week-afternoon"',
    );
  });

  it("reports YAML and schema errors from every file at once", () => {
    const dir = scenariosDir({
      "book/broken.yaml": "id: [unclosed",
      "book/empty.yaml": "id: empty\n",
    });
    const found = problems(dir);
    expect(found.some((p) => p.startsWith("book/broken.yaml: YAML parse error"))).toBe(true);
    expect(found.some((p) => p.startsWith("book/empty.yaml: "))).toBe(true);
  });
});

describe("schema refinements", () => {
  const base = loadScenarios().scenarios.find((s) => s.id === "book-derm-next-week-afternoon");
  const l1 = loadScenarios().l1.find((c) => c.id === "l1-emergency-911");
  if (base === undefined || l1 === undefined) throw new Error("fixture scenarios missing");

  it("surface: api needs a request", () => {
    expect(Scenario.safeParse({ ...base, surface: "api" }).success).toBe(false);
  });

  it("the script can't be longer than max_turns", () => {
    expect(Scenario.safeParse({ ...base, script: ["a", "b", "c"], max_turns: 2 }).success).toBe(false);
  });

  it("response_must_match_none patterns must compile", () => {
    const doc = {
      ...base,
      expect: { ...base.expect, trajectory: [{ response_must_match_none: ["(unclosed"] }] },
    };
    expect(Scenario.safeParse(doc).success).toBe(false);
  });

  it.each([
    ["an empty contains_ci", { reason: { contains_ci: "" } }],
    ["a contains_ci with an extra key", { reason: { contains_ci: "eczema", typo: "x" } }],
    ["an empty one_of", { date_range: { end_date: { one_of: [] } } }],
  ])("rejects %s in args_subset (8c21660/TEST-201)", (_what, args_subset) => {
    const c = l1Case("l1-book-after-explicit-yes");
    expect(L1Case.safeParse({ ...c, expect: { ...c.expect, args_subset } }).success).toBe(false);
    const ok = { reason: { contains_ci: "eczema" }, date_range: { end_date: { one_of: ["2026-11-06"] } } };
    expect(L1Case.safeParse({ ...c, expect: { ...c.expect, args_subset: ok } }).success).toBe(true);
  });

  it("L1: exactly one of action or any_of", () => {
    const both = { ...l1, expect: { ...l1.expect, any_of: [{ action: "respond" }] } };
    expect(L1Case.safeParse(both).success).toBe(false);
    const neither = { forbid_tools: "all", response: { contains_all: ["911"] } };
    expect(L1Case.safeParse({ ...l1, expect: neither }).success).toBe(false);
    expect(L1Case.safeParse({ ...l1, expect: { ...neither, action: "respond" } }).success).toBe(true);
  });

  it("L1: a tool_call action names its tool", () => {
    expect(L1Case.safeParse({ ...l1, expect: { action: "tool_call" } }).success).toBe(false);
    expect(L1Case.safeParse({ ...l1, expect: { any_of: [{ action: "tool_call" }] } }).success).toBe(false);
  });

  it("L1: a context tool result must match the tool's output contract", () => {
    const context = [
      { tool_call: { tool: "get_my_appointments", args: {} } },
      { tool_result: { tool: "get_my_appointments", result: { appointments: "none" } } },
    ];
    expect(L1Case.safeParse({ ...l1, context }).success).toBe(false);
  });
});

describe("schema: strictness and contract checks", () => {
  const base = scenario("book-derm-next-week-afternoon");

  it("rejects a misspelled key instead of silently dropping a check", () => {
    const { expect: ex, ...rest } = base;
    expect(Scenario.safeParse({ ...rest, expect: { ...ex, trajectroy: [] } }).success).toBe(false);
  });

  it("rejects a tool name that isn't in the contracts", () => {
    const doc = {
      ...base,
      expect: { ...base.expect, trajectory: [{ forbid_tools: ["cancel_appointment"] }] },
    };
    expect(Scenario.safeParse(doc).success).toBe(false);
  });

  it("rejects respond_immediately pointing past the script", () => {
    const doc = {
      ...base,
      script: ["hi"],
      expect: {
        ...base.expect,
        trajectory: [{ respond_immediately: { after_script_step: 2, contains_all: ["911"] } }],
      },
    };
    expect(Scenario.safeParse(doc).success).toBe(false);
  });

  it("rejects an L1 context whose tool args break the contract", () => {
    const c = l1Case("l1-book-after-explicit-yes");
    const context = [
      { tool_call: { tool: "book_appointment", args: { slot_id: "slot_x", patient_id: "p" } } },
      ...c.context.slice(-1),
    ];
    expect(L1Case.safeParse({ ...c, context }).success).toBe(false);
  });

  it("rejects an L1 context that ends with the assistant", () => {
    const c = l1Case("l1-emergency-911");
    expect(L1Case.safeParse({ ...c, context: [...c.context, { assistant: "ok" }] }).success).toBe(false);
  });
});
