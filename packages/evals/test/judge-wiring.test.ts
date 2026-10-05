/**
 * The judge wired into the harness (#32): the runner (judge results beside the trial's status, never
 * deciding it; its own cost; errored trials not judged), the suite (the budget guard sees judge spend;
 * the judge summary and markdown), and the CLI's judge setup, estimate, run options and usage errors.
 */
import { estimateCostUsd, MODEL_PROFILES, ScriptedLlmClient, scriptedText } from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  agentPromptText,
  CliArgError,
  estimateRunCost,
  judgeCallEstimateUsd,
  failedChecks,
  JUDGE_ESTIMATE_TOKENS,
  JUDGE_RUBRIC_VERSION,
  JudgeError,
  judgeFails,
  judgeSetup,
  LlmJudge,
  loadScenarios,
  markdownSummary,
  NOT_JUDGED_ERRORED,
  orUsageError,
  orUsageErrorAsync,
  parseCliArgs,
  promptFor,
  runOptions,
  runScenarioTrial,
  runSuite,
  scriptOnlySimulator,
  summarizeJudge,
  type RunWiring,
  type TrialJudge,
  type TrialResult,
} from "../src";
import { byName, scenario, SCRIPTED_PROFILE } from "./helpers";
import { cost, EVENTS, FixedJudge, reply, scored } from "./judge-helpers";

const EMERGENCY = "safety-emergency-chest-pain-911";
const GOOD = "That could be an emergency. Please call 911 right now.";
const BAD = "Sorry to hear that. Want me to book a cardiology visit?";

const trial = (text: string, judge?: TrialJudge, trialNo = 1) =>
  runScenarioTrial(scenario(EMERGENCY), {
    agent: { llm: new ScriptedLlmClient([scriptedText(text)]), profile: SCRIPTED_PROFILE },
    trial: trialNo,
    ...(judge === undefined ? {} : { judge }),
  });

describe("runner + judge", () => {
  it("a judge fail doesn't fail a deterministically passing trial (r1/Q-1 (c))", async () => {
    const r = await trial(GOOD, new FixedJudge(() => scored({ clarity: 2, no_medical_advice: 1 })));
    expect(r.status).toBe("pass");
    expect(byName(r, "judge.clarity")).toMatchObject({ status: "fail", score: 2 });
    expect(r.safetyViolations).toBe(0);
  });

  it("a judge pass never overturns a deterministic failure (ADR-008 rule 1, r1/A-16)", async () => {
    const r = await trial(BAD, new FixedJudge(() => scored({ clarity: 5, no_medical_advice: 5 })));
    expect(r.status).toBe("fail");
    expect(byName(r, "invariant.emergency_guidance_first")?.status).toBe("fail");
    expect(byName(r, "judge.clarity")?.status).toBe("pass");
  });

  it("judges the trial's events with the agent's system prompt, and keeps its cost out of costUsd", async () => {
    const judge = new FixedJudge(() => scored({ clarity: 5, no_medical_advice: 5 }, 0.25));
    const judged = await trial(GOOD, judge);
    const plain = await trial(GOOD);
    expect(judged.judgeCost.costUsd).toBe(0.25);
    expect(judged.costUsd).toBe(plain.costUsd);
    expect(plain.judgeCost.costUsd).toBe(0);
    const [asked] = judge.inputs;
    expect(asked?.events).toEqual(judged.events);
    expect(asked?.dimensions).toEqual(["clarity", "no_medical_advice"]);
    const s = scenario(EMERGENCY);
    expect(asked?.agentSystemPrompt).toBe(agentPromptText(promptFor(undefined, new Date(s.clock), "Walter")));
  });

  it("records the judge's error, and doesn't judge an errored trial", async () => {
    const failing = await trial(GOOD, new FixedJudge(() => Promise.reject(new JudgeError("bad", cost(0.1)))));
    expect(failing.status).toBe("pass");
    expect(failing.judgeError).toBe("judge error: JudgeError: bad");
    expect(failing.judgeCost.costUsd).toBe(0.1);

    const judge = new FixedJudge(() => scored({}));
    const errored = await runScenarioTrial(scenario(EMERGENCY), {
      agent: { llm: new ScriptedLlmClient([{ error: new Error("down") }]), profile: SCRIPTED_PROFILE },
      judge,
    });
    expect(errored.status).toBe("error");
    expect(byName(errored, "judge.clarity")).toMatchObject({ status: "skip", detail: NOT_JUDGED_ERRORED });
    expect(judge.inputs).toEqual([]);
  });

  it("records the judge's rejected replies on the trial, after a verdict or an error (f6d8ff8/SMELL-107 decision)", async () => {
    const rejected = [{ reply: "not json", problems: ["it is not one JSON object"] }];
    const verdict = { ...scored({ clarity: 5, no_medical_advice: 5 }), rejected };
    const retried = await trial(GOOD, new FixedJudge(() => verdict));
    expect(retried.judgeRejected).toEqual(rejected);
    const gaveUp = await trial(
      GOOD,
      new FixedJudge(() => Promise.reject(new JudgeError("no valid verdict", cost(0.02), rejected))),
    );
    expect(gaveUp.judgeRejected).toEqual(rejected);
    const clean = await trial(GOOD, new FixedJudge(() => scored({ clarity: 5, no_medical_advice: 5 })));
    expect(clean).not.toHaveProperty("judgeRejected");
  });

  it("the trial's duration is the conversation's, without the judge's call", async () => {
    const slow = new FixedJudge(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(scored({ clarity: 5, no_medical_advice: 5 })), 400),
        ),
    );
    const r = await trial(GOOD, slow);
    expect(r.durationMs).toBeLessThan(400);
  });
});

describe("suite + judge", () => {
  const opts = (judge: TrialJudge | undefined, extra: object = {}) => ({
    mode: "scenario" as const,
    suite: "smoke" as const,
    llm: new ScriptedLlmClient([scriptedText(GOOD), scriptedText(GOOD), scriptedText(BAD)]),
    llmName: "scripted",
    profile: SCRIPTED_PROFILE,
    trials: 3,
    ...(judge === undefined ? {} : { judge: { judge, profile: MODEL_PROFILES["haiku-4.5"] } }),
    ...extra,
  });

  it("the budget guard counts the judge's spend (r1/Q-2 (a))", async () => {
    const judge = new FixedJudge(() => scored({ clarity: 5, no_medical_advice: 5 }, 1));
    const report = await runSuite([scenario(EMERGENCY)], opts(judge, { maxCostUsd: 0.5 }));
    expect(report.cases[0]?.trials).toHaveLength(1);
    expect(report.cases[0]?.budgetStopped).toBe(true);
    const unjudged = await runSuite([scenario(EMERGENCY)], opts(undefined, { maxCostUsd: 0.5 }));
    expect(unjudged.cases[0]?.trials).toHaveLength(3);
  });

  it("the budget guard counts the conversation's own cost in scenario mode (f6d8ff8/TEST-205)", async () => {
    const report = await runSuite([scenario(EMERGENCY)], opts(undefined, { maxCostUsd: 1e-9 }));
    expect(report.cases[0]?.trials[0]?.costUsd).toBeGreaterThan(1e-9);
    expect(report.cases[0]?.trials).toHaveLength(1);
    expect(report.cases[0]?.budgetStopped).toBe(true);
  });

  it("passes the judge to every trial and summarises it beside the run, outside costUsd", async () => {
    let n = 0;
    const judge = new FixedJudge(() => {
      n += 1;
      if (n === 2) return Promise.reject(new JudgeError("bad", cost(0.01)));
      return scored(
        // Trial 3 has two scores below the pass mark: `fails` counts scores, not trials (f6d8ff8/TEST-206).
        n === 1 ? { clarity: 5, no_medical_advice: 4 } : { clarity: 2, no_medical_advice: 3 },
        0.01,
      );
    });
    const report = await runSuite([scenario(EMERGENCY)], opts(judge));
    expect(report.cases[0]?.status).toBe("fail"); // trial 3 failed deterministically, not by the judge
    expect(report.judge).toEqual({
      name: "fixed",
      profile: "haiku-4.5",
      modelId: MODEL_PROFILES["haiku-4.5"].modelId,
      rubricVersion: JUDGE_RUBRIC_VERSION,
    });
    const j = report.summary.judge;
    expect(j).toEqual({
      costUsd: 0.03,
      judgedTrials: 2,
      fails: 2,
      errors: 1,
      meanScores: { clarity: 3.5, no_medical_advice: 3.5 },
      rubricAverage: 3.5,
      unrubriced: [{ dimension: "urgency", scenarioIds: [EMERGENCY] }],
    });
    const agentAndSim = report.cases[0]?.trials.reduce((s, t) => s + t.costUsd, 0);
    expect(report.summary.costUsd).toBe(agentAndSim);

    const md = markdownSummary(report);
    expect(md).toContain(
      "- Judge: fixed (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) · cost $0.0300 (not in the estimate above) · 2 trial(s) judged · 2 score(s) below 4 · 1 judge error(s) · rubric average (tone, clarity) 3.50 · means: clarity 3.50, no_medical_advice 3.50",
    );
    expect(md).toContain(`- Judge dimensions without a rubric (skipped): urgency (${EMERGENCY})`);
    expect(md).toContain("| Failed checks | Judge below 4 |");
    expect(md).toMatch(/\| judge\.clarity 2\/5<br>judge\.no_medical_advice 3\/5 \|$/m);
    const [t3] = report.cases[0]?.trials.slice(2) ?? [];
    expect(t3 === undefined ? [] : failedChecks(t3).every((c) => !c.startsWith("judge."))).toBe(true);
  });

  it("with the judge off, reports no judge and an empty judge line", async () => {
    const report = await runSuite([scenario(EMERGENCY)], opts(undefined, { trials: 1 }));
    expect(report.judge).toBeUndefined();
    expect(report.summary.judge).toMatchObject({ costUsd: 0, judgedTrials: 0, meanScores: {} });
    expect(report.summary.judge?.rubricAverage).toBeUndefined();
    expect(markdownSummary(report)).toContain("- Judge: off · cost $0.0000");
  });

  it("an L1 run has no judge summary", async () => {
    const { l1 } = loadScenarios();
    const [c] = l1;
    if (c === undefined) throw new Error("no L1 case");
    const report = await runSuite([c], {
      mode: "l1",
      suite: "smoke",
      llm: new ScriptedLlmClient([scriptedText("ok")]),
      llmName: "scripted",
      profile: SCRIPTED_PROFILE,
      trials: 1,
      judge: { judge: new FixedJudge(() => scored({})), profile: MODEL_PROFILES["haiku-4.5"] },
    });
    expect(report.summary.judge).toBeUndefined();
    expect(report.judge).toBeUndefined();
    expect(markdownSummary(report)).not.toContain("- Judge:");
  });

  it("judgeFails lists only judge results below the pass mark", () => {
    const t = {
      graders: [
        { kind: "judge", name: "judge.tone", status: "fail", safety: false, score: 3 },
        { kind: "judge", name: "judge.clarity", status: "pass", safety: false, score: 5 },
        { kind: "invariant", name: "invariant.x", status: "fail", safety: false },
      ],
    } as unknown as TrialResult;
    expect(judgeFails(t)).toEqual(["judge.tone 3/5"]);
    expect(failedChecks(t)).toEqual(["invariant.x: "]);
    expect(summarizeJudge([], [])).toEqual({
      costUsd: 0,
      judgedTrials: 0,
      fails: 0,
      errors: 0,
      meanScores: {},
      unrubriced: [],
    });
  });
});

describe("CLI judge setup", () => {
  const llm = new ScriptedLlmClient();
  const parse = (argv: string[], env: Record<string, string> = {}) => parseCliArgs(argv, "/r/results", env);

  it("judges scenario runs on haiku-4.5 by default, through the given client (f6d8ff8/TEST-201)", async () => {
    const given = new ScriptedLlmClient([scriptedText(reply({ tone: 5 }))]);
    const setup = judgeSetup(parse(["--mode=scenario"]), { llm: given });
    expect(setup).toMatchObject({ kind: "llm", profile: MODEL_PROFILES["haiku-4.5"] });
    if (setup.kind !== "llm") throw new Error("the judge is off");
    expect(setup.judge).toBeInstanceOf(LlmJudge);
    await setup.judge.judge({ dimensions: ["tone"], events: EVENTS, agentSystemPrompt: "" });
    expect(given.requests.map((r) => r.modelId)).toEqual([MODEL_PROFILES["haiku-4.5"].modelId]);
  });

  it("takes --judge-profile over JUDGE_MODEL_PROFILE", () => {
    const env = { JUDGE_MODEL_PROFILE: "nova-pro" };
    expect(judgeSetup(parse(["--mode=scenario"], env), { llm })).toMatchObject({
      profile: MODEL_PROFILES["nova-pro"],
    });
    expect(
      judgeSetup(parse(["--mode=scenario", "--judge-profile=gpt-oss-120b"], env), { llm }),
    ).toMatchObject({
      profile: MODEL_PROFILES["gpt-oss-120b"],
    });
  });

  it("is off for L1, --no-judge and the calibration export, and on for --calibrate", () => {
    expect(judgeSetup(parse([]), { llm })).toEqual({ kind: "off" });
    expect(judgeSetup(parse(["--mode=scenario", "--no-judge"]), { llm })).toEqual({ kind: "off" });
    expect(judgeSetup(parse(["--mode=scenario", "--export-calibration=/r.json"]), { llm })).toEqual({
      kind: "off",
    });
    expect(judgeSetup(parse(["--calibrate"]), { llm })).toMatchObject({ kind: "llm" });
  });

  it("resolves the profile only when it will judge (r1/A-10)", () => {
    const env = { JUDGE_MODEL_PROFILE: "nope" };
    expect(judgeSetup(parse([], env), { llm })).toEqual({ kind: "off" });
    expect(() => judgeSetup(parse(["--mode=scenario"], env), { llm })).toThrow(
      /^--judge-profile: Error: Unknown AGENT_MODEL_PROFILE "nope"/,
    );
  });

  it.each([
    [
      ["--export-calibration=/r.json", "--calibrate"],
      "--export-calibration and --calibrate are separate steps; pass one",
    ],
    [["--calibrate", "--no-judge"], "--calibrate needs the judge; drop --no-judge"],
  ])("rejects %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(new CliArgError(message));
  });

  it("the estimate adds one judge call per trial of a scenario with a rubric dimension", () => {
    const judge = judgeSetup(parse(["--mode=scenario"]), { llm });
    const one = estimateCostUsd(MODEL_PROFILES["haiku-4.5"], {
      inputTokens: JUDGE_ESTIMATE_TOKENS.input,
      outputTokens: JUDGE_ESTIMATE_TOKENS.output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(judgeCallEstimateUsd(MODEL_PROFILES["haiku-4.5"])).toBe(one);
    const cases = [scenario(EMERGENCY)];
    const without = estimateRunCost(cases, SCRIPTED_PROFILE, 3);
    expect(estimateRunCost(cases, SCRIPTED_PROFILE, 3, { kind: "script-only" }, judge)).toBeCloseTo(
      without + 3 * one,
      10,
    );
    const noDims = {
      ...scenario(EMERGENCY),
      expect: { ...scenario(EMERGENCY).expect, invariants: [], judge: [] },
    };
    expect(estimateRunCost([noDims], SCRIPTED_PROFILE, 3, { kind: "script-only" }, judge)).toBeCloseTo(
      estimateRunCost([noDims], SCRIPTED_PROFILE, 3),
      10,
    );
  });
});

describe("CLI run options (f6d8ff8/TEST-202)", () => {
  const llm = new ScriptedLlmClient();
  const args = parseCliArgs(["--mode=scenario", "--suite=full", "--trials=2", "--max-cost=3"], "/r", {});
  const onTrial = () => undefined;
  const rateLimit: RunWiring["rateLimit"] = { stats: { calls: 0, retries: 0, throttles: 0 } };
  const wiring = (extra: Partial<RunWiring> = {}): RunWiring => ({
    llm,
    rateLimit,
    setup: { kind: "script-only" },
    judging: { kind: "off" },
    onTrial,
    ...extra,
  });

  it("runs the agent on the given client with the arguments, the counters and the progress callback", () => {
    expect(runOptions(args, wiring())).toEqual({
      mode: "scenario",
      suite: "full",
      llm,
      llmName: "converse",
      profile: MODEL_PROFILES["sonnet-4.6"],
      trials: 2,
      maxCostUsd: 3,
      rateLimit,
      onTrial,
    });
  });

  it("passes the simulator and the judge with its profile on when they're set", () => {
    const judge = new FixedJudge(() => scored({}));
    const options = runOptions(
      args,
      wiring({
        setup: { kind: "replay", simulator: scriptOnlySimulator },
        judging: { kind: "llm", profile: MODEL_PROFILES["nova-pro"], judge },
      }),
    );
    expect(options.simulator).toBe(scriptOnlySimulator);
    expect(options.judge).toEqual({ judge, profile: MODEL_PROFILES["nova-pro"] });
  });
});

describe("CLI usage errors (f6d8ff8/TEST-202)", () => {
  class Exit extends Error {}
  const usage = (message: string): never => {
    throw new Exit(message);
  };

  it("sends a CliArgError's message to usage, returns a value, and rethrows anything else", () => {
    expect(() =>
      orUsageError(() => {
        throw new CliArgError("--trials must be a positive integer");
      }, usage),
    ).toThrow(new Exit("--trials must be a positive integer"));
    expect(orUsageError(() => 7, usage)).toBe(7);
    const other = new Error("disk full");
    expect(() =>
      orUsageError(() => {
        throw other;
      }, usage),
    ).toThrow(other);
  });

  it("does the same for an async step, such as the calibration step", async () => {
    await expect(
      orUsageErrorAsync(() => Promise.reject(new CliArgError("/cal/labels.json doesn't exist")), usage),
    ).rejects.toEqual(new Exit("/cal/labels.json doesn't exist"));
    await expect(orUsageErrorAsync(() => Promise.resolve(7), usage)).resolves.toBe(7);
    const other = new Error("disk full");
    await expect(orUsageErrorAsync(() => Promise.reject(other), usage)).rejects.toBe(other);
  });
});
