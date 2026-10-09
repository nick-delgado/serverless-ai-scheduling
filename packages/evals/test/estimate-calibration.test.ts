/**
 * The pre-run estimate against recorded runs (#34, r1/A-9): conservative, between 1.0x and 1.5x of what each
 * recorded `sonnet-4.6` run cost. The figures are the runs' own totals (the judge included in scenario mode):
 * - scenario smoke, 2026-10-07T140228Z and T142126Z (prompt `system.v1`, 8 cases, k=1): $0.3400 and $0.3856;
 * - scenario full, PR #165 (`40dbee6`, k=1): $2.16 (agent $1.36, simulator $0.59, judge $0.22);
 * - L1 smoke, five runs on 2026-10-07 (8 cases, k=1): $0.0567 to $0.0572 with a cold cache, $0.0403 warm.
 */
import { MODEL_PROFILES, ScriptedLlmClient } from "@sched/agent";
import { describe, expect, it } from "vitest";

import { estimateRunCost, judgeSetup, loadScenarios, selectSuite, simulatorSetup } from "../src";

const loaded = loadScenarios();
const sonnet = MODEL_PROFILES["sonnet-4.6"];
const llm = new ScriptedLlmClient();
const sim = simulatorSetup({ mode: "scenario" }, { llm, readReplay: () => ({}) });
const judge = judgeSetup({ mode: "scenario", judge: true }, { llm });

describe("estimateRunCost against recorded runs (#34, r1/A-9)", () => {
  it("scenario smoke: 1.0x to 1.5x of both recorded runs", () => {
    const estimate = estimateRunCost(selectSuite(loaded.scenarios, "smoke"), sonnet, 1, sim, judge);
    for (const recorded of [0.34, 0.3856]) {
      expect(estimate / recorded).toBeGreaterThanOrEqual(1);
      expect(estimate / recorded).toBeLessThanOrEqual(1.5);
    }
  });

  it("scenario full: 1.0x to 1.5x of PR #165's run", () => {
    const estimate = estimateRunCost(loaded.scenarios, sonnet, 1, sim, judge);
    expect(estimate / 2.16).toBeGreaterThanOrEqual(1);
    expect(estimate / 2.16).toBeLessThanOrEqual(1.5);
  });

  it("L1 smoke: at least every cold run, at most 1.5x of them", () => {
    const estimate = estimateRunCost(selectSuite(loaded.l1, "smoke"), sonnet, 1);
    expect(estimate).toBeGreaterThanOrEqual(0.0572);
    expect(estimate / 0.0567).toBeLessThanOrEqual(1.5);
  });
});
