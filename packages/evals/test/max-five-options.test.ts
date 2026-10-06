/**
 * `max_five_options` counts the clock times on list lines (#181, r1/Q-1 (a)): a time the reply only
 * repeats in prose, such as a search floor, the patient's own time or the clinic's hours, is not an
 * option. A message with no list line that carries a time counts every time, as before. Recorded text
 * comes read-only from `calibration/transcripts.json`; the PR #179 rerun's trial 2 is hand-built
 * (r1/Q-3 (b)), because its results file wasn't kept.
 */
import { describe, expect, it } from "vitest";

import { listItemLines, type Invariant, type TranscriptEvent } from "../src";
import { assistant, byName, invariants, recorded } from "./helpers";

const ID = "book-derm-next-week-afternoon";
const ONLY: Invariant[] = ["max_five_options"];

/** The `max_five_options` result for these events, graded under `ID` (or the recorded trial's scenario). */
async function maxFive(events: TranscriptEvent[], id = ID) {
  const { results } = await invariants(id, events, ONLY);
  return byName(results, "invariant.max_five_options");
}

const scenarioOf = (trial: string) => trial.split("#")[0] ?? trial;

/** Five list lines from one search after a 2:00 PM floor, two at the inclusive floor itself. */
const FIVE_AFTER_TWO = [
  "2:00 PM ET — Dr. Priya Lee",
  "2:00 PM ET — Dr. Samuel Okafor",
  "2:30 PM ET — Dr. Priya Lee",
  "2:30 PM ET — Dr. Samuel Okafor",
  "3:00 PM ET — Dr. Priya Lee",
];

const numbered = (lines: readonly string[], marker = (i: number) => `${String(i + 1)}.`, indent = "") =>
  lines.map((l, i) => `${indent}${marker(i)} ${l}`).join("\n");

/** PR #179's rerun trial 2, hand-built: the header echoes the `start_time` floor. */
const TRIAL_2 = `Here are the open afternoon slots after 2:00 PM ET on Tuesday, October 13:\n\n${numbered(FIVE_AFTER_TWO)}\n\nWhich one works for you?`;

describe("max_five_options: a repeated time beside five listed options is not a sixth (#181)", () => {
  it("passes PR #179's trial 2, whose header echoes the 2:00 PM floor (hand-built, r1/Q-3 (b))", async () => {
    expect(await maxFive([assistant(TRIAL_2)])).toMatchObject({ status: "pass" });
  });

  it.each([
    ["book-derm-next-week-afternoon#1", "a floor and a ceiling in prose: 12:00 PM and 1:00 PM"],
    ["reschedule-into-est-after-dst#1", "the patient's requested 11:30 AM"],
    ["availability-cardiology-est-week#1", "more times named in prose after a list (r1/Q-2 (a))"],
    ["availability-derm-next-week-mornings#1", "more times named in prose after a list (r1/Q-2 (a))"],
  ])("passes recorded %s, which repeats %s", async (trial) => {
    expect(await maxFive(recorded(trial), scenarioOf(trial))).toMatchObject({ status: "pass" });
  });

  it("passes five listed options beside the clinic's hours (hand-built)", async () => {
    const text = `We're open 8:00 AM to 5:00 PM ET on weekdays. Dr. Lee has these openings on Tuesday, October 13:\n${numbered(FIVE_AFTER_TWO)}`;
    expect(await maxFive([assistant(text)])).toMatchObject({ status: "pass" });
  });

  it.each([
    ["-", () => "-", ""],
    ["*", () => "*", ""],
    ["•", () => "•", ""],
    ["1)", (i: number) => `${String(i + 1)})`, ""],
    ["an indented 1.", (i: number) => `${String(i + 1)}.`, "  "],
  ])("reads %s list lines", async (_what, marker, indent) => {
    const text = `Here are the slots after 2:00 PM ET on Tuesday, October 13:\n${numbered(FIVE_AFTER_TWO, marker, indent)}`;
    expect(await maxFive([assistant(text)])).toMatchObject({ status: "pass" });
  });

  it("does not read a bold heading as a list line: its marker has no space after it", async () => {
    const text = `**After 2:00 PM on Tuesday, October 13:**\n${numbered(FIVE_AFTER_TWO)}`;
    expect(await maxFive([assistant(text)])).toMatchObject({ status: "pass" });
  });
});

describe("max_five_options: six or more counted times still fail (#181)", () => {
  it("fails ten list lines merged from two searches, and counts each line (r1/A-1)", async () => {
    const thursday = FIVE_AFTER_TWO.map((l) => `Thursday, ${l}`);
    const tuesday = FIVE_AFTER_TWO.map((l) => `Tuesday, ${l}`);
    const text = `Here is everything after 2:00 PM ET on both days:\n${numbered([...tuesday, ...thursday])}`;
    expect(await maxFive([assistant(text)])).toMatchObject({
      status: "fail",
      detail: "10 times in one message",
    });
  });

  it.each([
    ["clarify-unsupported-specialty#1", "two providers at the same five times (r1/A-1)", 10],
    ["clarify-two-requests-one-message#1", "one reschedule slot and five therapy slots (r1/A-2)", 6],
  ])("fails recorded %s, which lists %s", async (trial, _what, n) => {
    expect(await maxFive(recorded(trial), scenarioOf(trial))).toMatchObject({
      status: "fail",
      detail: `${String(n)} times in one message`,
    });
  });

  it("counts every time when no list line carries one, even beside list lines without times", async () => {
    const text =
      "Dr. Lee has 1:00 PM, 1:30 PM, 2:00 PM, 2:30 PM, 3:00 PM and 3:30 PM ET on Tuesday, October 13.\n\nTo book, I'll need:\n- the time you'd like\n- the reason for your visit";
    expect(await maxFive([assistant(text)])).toMatchObject({
      status: "fail",
      detail: "6 times in one message",
    });
  });

  it("counts an echo when the five options are inline, not listed (r1/Q-1 (a) fallback)", async () => {
    const text =
      "After 2:00 PM ET on Tuesday, October 13, Dr. Lee has 2:00 PM, 2:30 PM, 3:00 PM, 3:30 PM and 4:00 PM ET.";
    expect(await maxFive([assistant(text)])).toMatchObject({
      status: "fail",
      detail: "6 times in one message",
    });
  });

  it("counts a bulleted heading's time: a known gap (r1/A-8)", async () => {
    const text = `- After 2:00 PM on Tuesday, October 13:\n${numbered(FIVE_AFTER_TWO)}`;
    expect(await maxFive([assistant(text)])).toMatchObject({
      status: "fail",
      detail: "6 times in one message",
    });
  });

  it("fails six listed options", async () => {
    const text = numbered([...FIVE_AFTER_TWO, "3:00 PM ET — Dr. Samuel Okafor"]);
    expect(await maxFive([assistant(text)])).toMatchObject({
      status: "fail",
      detail: "6 times in one message",
    });
  });
});

describe("listItemLines", () => {
  it("returns each list line with the index of its first character", () => {
    const text = "Intro:\n1. first\nprose\n- second";
    expect(listItemLines(text)).toEqual([
      { text: "1. first", index: 7 },
      { text: "- second", index: 22 },
    ]);
    expect(text.slice(22, 22 + "- second".length)).toBe("- second");
  });
});
