/**
 * Loads and validates every scenario file under `packages/evals/scenarios/<category>/<id>.yaml`.
 * All problems across all files are collected and thrown together, so one run shows every broken file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import type { z } from "zod";

import { isL1Case, L1Case, Scenario } from "./schema";
import { issueText } from "./util";

export const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "scenarios");

export interface LoadedScenarios {
  /** Multi-turn scenarios (L2/L3), sorted by id. */
  scenarios: Scenario[];
  /** Single-turn cases (`l1/`), sorted by id. */
  l1: L1Case[];
}

export class ScenarioLoadError extends Error {
  override readonly name = "ScenarioLoadError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid scenario files (${problems.length}):\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}

function formatIssues(file: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${file}: ${issueText(issue)}`);
}

export function loadScenarios(dir: string = SCENARIOS_DIR): LoadedScenarios {
  const problems: string[] = [];
  const scenarios: Scenario[] = [];
  const l1: L1Case[] = [];
  const seen = new Set<string>();

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of readdirSync(join(dir, entry.name)).sort()) {
      if (!name.endsWith(".yaml")) continue;
      const path = join(dir, entry.name, name);
      const file = relative(dir, path);
      let doc: unknown;
      try {
        doc = parse(readFileSync(path, "utf8"));
      } catch (error) {
        problems.push(`${file}: YAML parse error: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const parsed = entry.name === "l1" ? L1Case.safeParse(doc) : Scenario.safeParse(doc);
      if (!parsed.success) {
        problems.push(...formatIssues(file, parsed.error));
        continue;
      }
      const value = parsed.data;
      if (value.id !== basename(name, ".yaml"))
        problems.push(`${file}: id "${value.id}" must match the file name`);
      if (value.category !== entry.name)
        problems.push(`${file}: category "${value.category}" must match the folder`);
      if (seen.has(value.id)) problems.push(`${file}: duplicate id "${value.id}"`);
      seen.add(value.id);
      if (isL1Case(value)) l1.push(value);
      else scenarios.push(value);
    }
  }

  if (problems.length > 0) throw new ScenarioLoadError(problems);
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return { scenarios: scenarios.sort(byId), l1: l1.sort(byId) };
}

export const SUITES = ["smoke", "full"] as const;
export type Suite = (typeof SUITES)[number];

/** `smoke`: cases tagged `smoke` (the PR gate, ADR-008). `full`: everything. */
export function selectSuite<T extends { tags: string[] }>(cases: readonly T[], suite: Suite): T[] {
  return suite === "full" ? [...cases] : cases.filter((c) => c.tags.includes("smoke"));
}
