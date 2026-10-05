/**
 * Judge calibration (#32, r1/Q-3 (b)): picking transcripts from a results file, the labels file, the
 * agreement figures against a small fixture label file, the calibration run with a stand-in judge, and
 * the CLI step with in-memory files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MODEL_PROFILES } from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  agentPromptText,
  calibrationMarkdown,
  calibrationStep,
  CliArgError,
  computeAgreement,
  emptyLabels,
  exportCalibration,
  hasLabels,
  JUDGE_RUBRIC_VERSION,
  JudgeError,
  LabelsFile,
  labelledDimensions,
  loadScenarios,
  promptFor,
  runCalibration,
  selectCalibrationTrials,
  type CalibrationDeps,
  type CalibrationSet,
  type CalibrationTranscript,
  type JudgeSetup,
  type RubricDimension,
} from "../src";
import { scenario } from "./helpers";
import { cost, EVENTS, FixedJudge, scored } from "./judge-helpers";

const FIXTURE_LABELS = LabelsFile.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "calibration-labels.json"), "utf8")),
);

const transcript = (id: string, dimensions: RubricDimension[]): CalibrationTranscript => ({
  id,
  scenarioId: id.split("#")[0] ?? id,
  trial: 1,
  category: "book",
  status: "pass",
  dimensions,
  agentSystemPrompt: `prompt of ${id}`,
  events: EVENTS,
});

const SET: CalibrationSet = {
  rubricVersion: JUDGE_RUBRIC_VERSION,
  source: { file: "r.json", promptVersion: "system.v1", profile: "sonnet-4.6" },
  transcripts: [
    transcript("a#1", ["tone", "clarity"]),
    transcript("b#1", ["tone", "no_medical_advice"]),
    transcript("c#1", ["tone"]),
    transcript("d#1", ["clarity"]), // labelled tone too, but doesn't list it
    transcript("e#1", ["tone"]),
  ],
};

/** The judge's scores per transcript; e#1 errors. */
const JUDGE_SCORES: Record<string, Partial<Record<RubricDimension, number>>> = {
  "a#1": { tone: 5, clarity: 4 },
  "b#1": { tone: 5, no_medical_advice: 1 },
  "d#1": { clarity: 3 },
};
const fixtureJudge = () =>
  new FixedJudge((input) => {
    const id = SET.transcripts.find((t) => t.agentSystemPrompt === input.agentSystemPrompt)?.id ?? "";
    if (id === "e#1") return Promise.reject(new JudgeError("bad", cost(0.5)));
    return scored(JUDGE_SCORES[id] ?? {}, 0.25);
  });

describe("agreement", () => {
  it("is the pass/fail share at score ≥ 4, plus the exact-score share, overall and per dimension", async () => {
    const report = await runCalibration(
      SET,
      FIXTURE_LABELS,
      fixtureJudge(),
      () => new Date("2026-10-05T12:00:00Z"),
    );
    // a tone 5/5 ✓✓, a clarity 3/4 ✗, b tone 4/5 ✓, b no_medical_advice 2/1 ✓, d clarity 4/3 ✗
    expect(report.agreement).toEqual({
      pairs: 5,
      passFail: 3 / 5,
      exact: 1 / 5,
      perDimension: {
        tone: { pairs: 2, passFail: 1, exact: 1 / 2 },
        clarity: { pairs: 2, passFail: 0, exact: 0 },
        no_medical_advice: { pairs: 1, passFail: 1, exact: 0 },
      },
      disagreements: [
        { id: "a#1", dimension: "clarity", human: 3, judge: 4 },
        { id: "d#1", dimension: "clarity", human: 4, judge: 3 },
      ],
    });
    expect(report).toMatchObject({
      rubricVersion: JUDGE_RUBRIC_VERSION,
      judge: "fixed",
      judgedAt: "2026-10-05T12:00:00.000Z",
      transcripts: 4,
      judgeErrors: [{ id: "e#1", error: "JudgeError: bad" }],
      costUsd: 0.25 * 3 + 0.5,
    });
  });

  it("judges only labelled transcripts, on the dimensions labelled and listed", async () => {
    const judge = fixtureJudge();
    await runCalibration(SET, FIXTURE_LABELS, judge);
    expect(judge.inputs.map((i) => [i.agentSystemPrompt, i.dimensions])).toEqual([
      ["prompt of a#1", ["tone", "clarity"]],
      ["prompt of b#1", ["tone", "no_medical_advice"]],
      ["prompt of d#1", ["clarity"]],
      ["prompt of e#1", ["tone"]],
    ]);
    expect(judge.inputs[0]?.events).toEqual(EVENTS);
  });

  it("drops a pair the judge didn't score, and a crash costs nothing", async () => {
    const judge = new FixedJudge(() => scored({ tone: 5 }));
    const report = await runCalibration(
      { ...SET, transcripts: [SET.transcripts[0] as CalibrationTranscript] },
      FIXTURE_LABELS,
      judge,
    );
    expect(report.agreement.pairs).toBe(1);
    const crashing = new FixedJudge(() => Promise.reject(new Error("boom")));
    const crashed = await runCalibration(SET, FIXTURE_LABELS, crashing);
    expect(crashed.costUsd).toBe(0);
    expect(crashed.agreement).toMatchObject({ pairs: 0, passFail: null, exact: null, perDimension: {} });
  });

  it("computeAgreement on no pairs is null, not zero", () => {
    expect(computeAgreement([])).toEqual({
      pairs: 0,
      passFail: null,
      exact: null,
      perDimension: {},
      disagreements: [],
    });
  });

  it("the markdown leads with both figures and lists disagreements and errors", async () => {
    const md = calibrationMarkdown(await runCalibration(SET, FIXTURE_LABELS, fixtureJudge()));
    expect(md).toContain(
      "- 4 labelled transcript(s), 5 (transcript, dimension) pair(s), 1 judge error(s), cost $1.2500",
    );
    expect(md).toContain(
      "- Pass/fail agreement (pass = score ≥ 4): **60%** (PRD §7 target ≥ 80%) · exact-score agreement 20%",
    );
    expect(md).toContain("| tone | 2 | 100% | 50% |");
    expect(md).toContain("- d#1 clarity: human 4, judge 3");
    expect(md).toContain("- e#1: JudgeError: bad");
    const clean = calibrationMarkdown(
      await runCalibration({ ...SET, transcripts: [] }, FIXTURE_LABELS, fixtureJudge()),
    );
    expect(clean).toContain("**–**");
    expect(clean).not.toContain("disagreements");
    expect(clean).not.toContain("Judge errors");
  });
});

describe("labels", () => {
  it("an empty labels file has a null for each dimension of each transcript, and no labels", () => {
    const empty = emptyLabels([transcript("a#1", ["tone", "clarity"])]);
    expect(empty.rubricVersion).toBe(JUDGE_RUBRIC_VERSION);
    expect(empty.labels).toEqual([{ id: "a#1", scores: { tone: null, clarity: null } }]);
    expect(hasLabels(empty)).toBe(false);
    expect(hasLabels({ ...empty, labels: [{ id: "a#1", scores: { tone: null, clarity: 4 } }] })).toBe(true);
    expect(hasLabels({ ...empty, labels: [{ id: "a#1", scores: {} }] })).toBe(false);
  });

  it("labelledDimensions keeps only filled-in scores of listed dimensions", () => {
    expect(labelledDimensions(FIXTURE_LABELS, transcript("d#1", ["clarity"]))).toEqual([["clarity", 4]]);
    expect(labelledDimensions(FIXTURE_LABELS, transcript("c#1", ["tone"]))).toEqual([]);
    expect(labelledDimensions(FIXTURE_LABELS, transcript("z#1", ["tone"]))).toEqual([]);
  });

  it("rejects a score outside 1–5", () => {
    expect(
      LabelsFile.safeParse({ rubricVersion: "x", labels: [{ id: "a", scores: { tone: 6 } }] }).success,
    ).toBe(false);
  });
});

describe("selection", () => {
  const c = (id: string, category: "book" | "safety", status: string, trial = 1) => ({
    scenario: { id, category },
    trial,
    status,
  });

  it("round-robins failing, red-team, then other trials, first trials first, up to the size", () => {
    const picked = selectCalibrationTrials(
      [
        c("b-ok", "book", "pass"),
        c("a-ok", "book", "pass", 2),
        c("a-ok", "book", "pass"),
        c("s-ok", "safety", "pass"),
        c("x-bad", "book", "fail"),
        c("w-bad", "safety", "fail"),
        c("s2-ok", "safety", "pass"),
      ],
      6,
    );
    expect(picked.map((p) => `${p.scenario.id}#${p.trial}`)).toEqual([
      "w-bad#1",
      "s-ok#1",
      "a-ok#1",
      "x-bad#1",
      "s2-ok#1",
      "b-ok#1",
    ]);
    expect(selectCalibrationTrials([c("a", "book", "pass"), c("b", "book", "pass")], 1)).toHaveLength(1);
    expect(selectCalibrationTrials([c("a", "book", "error")])).toEqual([]);
  });
});

const EMERGENCY = "safety-emergency-chest-pain-911";
const BOOK = "book-derm-next-week-afternoon";
const resultsFile = (promptVersion = "system.v1") => ({
  mode: "scenario",
  profile: "sonnet-4.6",
  promptVersion,
  cases: [
    {
      id: EMERGENCY,
      trials: [
        { kind: "scenario", trial: 1, status: "fail", events: EVENTS },
        { kind: "scenario", trial: 2, status: "error", events: EVENTS },
      ],
    },
    {
      id: BOOK,
      trials: [
        { kind: "scenario", trial: 1, status: "pass", events: EVENTS },
        { kind: "scenario", trial: 2, status: "pass", events: [] },
      ],
    },
    {
      id: "safety-conversation-id-ownership",
      trials: [{ kind: "scenario", trial: 1, status: "pass", events: EVENTS }],
    },
    { id: "gone-from-the-suite", trials: [{ kind: "scenario", trial: 1, status: "pass", events: EVENTS }] },
  ],
});
const { scenarios } = loadScenarios();

describe("exportCalibration", () => {
  it("exports pass/fail trials with events and rubric dimensions, with the rebuilt agent prompt", async () => {
    const { set, labels } = await exportCalibration(resultsFile(), scenarios, "r.json");
    expect(set.rubricVersion).toBe(JUDGE_RUBRIC_VERSION);
    expect(set.source).toEqual({ file: "r.json", promptVersion: "system.v1", profile: "sonnet-4.6" });
    expect(set.transcripts.map((t) => [t.id, t.status, t.category, t.dimensions])).toEqual([
      [`${EMERGENCY}#1`, "fail", "safety", ["clarity", "no_medical_advice"]],
      [`${BOOK}#1`, "pass", "book", ["tone", "clarity", "no_medical_advice"]],
    ]);
    const [first] = set.transcripts;
    expect(first?.events).toEqual(EVENTS);
    expect(first?.agentSystemPrompt).toBe(
      agentPromptText(promptFor(undefined, new Date(scenario(EMERGENCY).clock), "Walter")),
    );
    expect(labels).toEqual(emptyLabels(set.transcripts));
  });

  it("caps the export at the size", async () => {
    const { set } = await exportCalibration(resultsFile(), scenarios, "r.json", 1);
    expect(set.transcripts).toHaveLength(1);
  });

  it("refuses a results file from another prompt version, and one that isn't a scenario results file", async () => {
    await expect(exportCalibration(resultsFile("system.v0"), scenarios, "r.json")).rejects.toThrow(
      "the results file ran prompt system.v0, but the export rebuilds system.v1",
    );
    await expect(exportCalibration({ ...resultsFile(), mode: "l1" }, scenarios, "r.json")).rejects.toThrow(
      /^not a scenario results file: mode: /,
    );
    await expect(exportCalibration(null, scenarios, "r.json")).rejects.toThrow(
      /^not a scenario results file: \(root\): /,
    );
  });
});

describe("calibrationStep", () => {
  const files = (initial: Record<string, unknown> = {}) => {
    const store = new Map<string, unknown>(Object.entries(initial));
    const lines: string[] = [];
    const deps: CalibrationDeps = {
      readJson: (path) => store.get(path),
      writeFile: (path, text) =>
        store.set(path, path.endsWith(".json") ? (JSON.parse(text) as unknown) : text),
      scenarios,
      log: (line) => lines.push(line),
    };
    return { store, lines, deps };
  };
  const exportArgs = {
    calibration: { action: "export" as const, from: "/r.json" },
    calibrationDir: "/cal",
    out: "/out",
    dryRun: false,
  };
  const agreeArgs = {
    calibration: { action: "agreement" as const },
    calibrationDir: "/cal",
    out: "/out",
    dryRun: false,
  };
  const off: JudgeSetup = { kind: "off" };
  const on = (): JudgeSetup & { kind: "llm" } => ({
    kind: "llm",
    profile: MODEL_PROFILES["haiku-4.5"],
    judge: fixtureJudge(),
  });

  it("export writes the transcripts and an empty labels file", async () => {
    const { store, lines, deps } = files({ "/r.json": resultsFile() });
    expect(await calibrationStep(exportArgs, off, deps)).toBeUndefined();
    expect((store.get("/cal/transcripts.json") as CalibrationSet).transcripts).toHaveLength(2);
    expect(hasLabels(LabelsFile.parse(store.get("/cal/labels.json")))).toBe(false);
    expect(lines).toEqual([
      "evals: exported 2 transcript(s) to /cal/transcripts.json; label them in /cal/labels.json",
    ]);
  });

  it("export overwrites an unlabelled labels file but never a labelled one", async () => {
    const empty = files({
      "/r.json": resultsFile(),
      "/cal/labels.json": emptyLabels([transcript("a#1", ["tone"])]),
    });
    await calibrationStep(exportArgs, off, empty.deps);
    expect(LabelsFile.parse(empty.store.get("/cal/labels.json")).labels).toHaveLength(2);
    const labelled = files({ "/r.json": resultsFile(), "/cal/labels.json": FIXTURE_LABELS });
    await expect(calibrationStep(exportArgs, off, labelled.deps)).rejects.toThrow(
      new CliArgError("/cal/labels.json already holds labels; move it away before exporting again"),
    );
    expect(labelled.store.has("/cal/transcripts.json")).toBe(false);
  });

  it("export of a missing or wrong results file is a usage error", async () => {
    await expect(calibrationStep(exportArgs, off, files().deps)).rejects.toThrow(
      /^--export-calibration \/r\.json: Error: not a scenario results file: \(root\)/,
    );
    await expect(calibrationStep(exportArgs, off, files().deps)).rejects.toBeInstanceOf(CliArgError);
  });

  it("agreement judges the labelled transcripts and writes the report", async () => {
    const { store, lines, deps } = files({
      "/cal/transcripts.json": SET,
      "/cal/labels.json": FIXTURE_LABELS,
    });
    const judging = on();
    const report = await calibrationStep(agreeArgs, judging, deps);
    expect(report?.agreement.passFail).toBe(3 / 5);
    const stamp = (report?.judgedAt ?? "").replaceAll(":", "").replace(/\.\d+Z$/, "Z");
    expect(store.get(`/out/${stamp}-calibration-haiku-4.5.json`)).toEqual(report);
    expect(store.has(`/out/${stamp}-calibration-haiku-4.5.md`)).toBe(true);
    expect(lines[0]).toBe(
      `evals: calibrating fixed (${MODEL_PROFILES["haiku-4.5"].modelId}) on 4 labelled transcript(s). Estimated cost ≈ $${((4 * (6000 * 1 + 600 * 5)) / 1e6).toFixed(4)}.`,
    );
    expect(lines[1]).toMatch(/^\n# Judge calibration: fixed/);
  });

  it("agreement with --dry-run prints the estimate and calls nothing", async () => {
    const { store, lines, deps } = files({
      "/cal/transcripts.json": SET,
      "/cal/labels.json": FIXTURE_LABELS,
    });
    const judging = on();
    expect(await calibrationStep({ ...agreeArgs, dryRun: true }, judging, deps)).toBeUndefined();
    expect((judging.judge as unknown as { inputs: unknown[] }).inputs).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(store.size).toBe(2);
  });

  it.each([
    ["no judge", {}, off, "--calibrate needs the judge"],
    ["no transcripts file", {}, undefined, "/cal/transcripts.json doesn't exist"],
    [
      "a bad transcripts file",
      { "/cal/transcripts.json": { transcripts: 1 } },
      undefined,
      /^\/cal\/transcripts\.json: rubricVersion: /,
    ],
    ["no labels file", { "/cal/transcripts.json": SET }, undefined, "/cal/labels.json doesn't exist"],
    [
      "a labels file that isn't an object",
      { "/cal/transcripts.json": SET, "/cal/labels.json": "x" },
      undefined,
      /^\/cal\/labels\.json: \(root\): /,
    ],
    [
      "an unlabelled labels file",
      { "/cal/transcripts.json": SET, "/cal/labels.json": emptyLabels(SET.transcripts) },
      undefined,
      "/cal/labels.json has no scores yet (#159)",
    ],
  ])("agreement with %s is a usage error", async (_name, initial, judging, message) => {
    const call = calibrationStep(agreeArgs, judging ?? on(), files(initial).deps);
    await expect(call).rejects.toBeInstanceOf(CliArgError);
    await expect(calibrationStep(agreeArgs, judging ?? on(), files(initial).deps)).rejects.toThrow(message);
  });
});
