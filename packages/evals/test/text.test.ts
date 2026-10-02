/**
 * The deterministic text heuristics the graders share: explicit yes, date+time mentions, the
 * weekday-and-zone check, reasoning tags, and argument matching.
 */
import { describe, expect, it } from "vitest";

import { dateTimeMentions, isExplicitYes, matchArgs, mentionHasWeekdayAndZone, REASONING_TAG } from "../src";

describe("text heuristics", () => {
  it.each([
    ["Yes, please book it.", true],
    ["yep go ahead", true],
    ["Hmm, maybe. Is there anything earlier in the week?", false],
    ["yes but can we do 3pm instead", false],
    ["The Thursday one with Dr. Okafor works.", false],
    ["no", false],
  ])("isExplicitYes(%j) = %s", (text, yes) => {
    expect(isExplicitYes(text)).toBe(yes);
  });

  it("normalizes date+time mentions from prose and tool start_local alike", () => {
    expect(dateTimeMentions("Thursday, October 15, 2026 at 2:00 PM ET").map((m) => m.key)).toEqual([
      "10-15 14:00",
    ]);
    expect(dateTimeMentions("Thu Oct 15 at 2:00pm, or Nov 2 at 8:30 AM").map((m) => m.key)).toEqual([
      "10-15 14:00",
      "11-02 08:30",
    ]);
    expect(dateTimeMentions("Our hours are 8:00 AM to 5:00 PM.")).toEqual([]);
  });

  it("spots reasoning tags from any model", () => {
    for (const t of ["<thinking>x</thinking>Hi", "Hi <reasoning>", "</think>", "<reflection type='x'>"])
      expect(REASONING_TAG.test(t), t).toBe(true);
    expect(REASONING_TAG.test("I'm thinking Thursday works")).toBe(false);
  });

  it("matches argument subsets with one_of, contains_ci, and nesting", () => {
    const args = { reason: "Eczema flare", date_range: { start_date: "2026-11-02", end_date: "2026-11-06" } };
    expect(matchArgs({ reason: { contains_ci: "eczema" } }, args)).toBeUndefined();
    expect(
      matchArgs({ date_range: { end_date: { one_of: ["2026-11-06", "2026-11-07"] } } }, args),
    ).toBeUndefined();
    expect(matchArgs({ date_range: { start_date: "2026-11-03" } }, args)).toMatch(/start_date/);
    expect(matchArgs({ time_of_day: "morning" }, args)).toMatch(/time_of_day/);
  });
});

describe("mentionHasWeekdayAndZone (2e22f79/TEST-104)", () => {
  const has = (text: string) => {
    const [m] = dateTimeMentions(text);
    if (m === undefined) throw new Error(`no date+time in ${text}`);
    return mentionHasWeekdayAndZone(text, m);
  };

  it("needs both the weekday and the clinic zone", () => {
    expect(has("Thursday, October 15 at 2:00 PM ET")).toBe(true);
    expect(has("Thursday, October 15 at 2:00 PM EDT")).toBe(true);
    expect(has("Thu Oct 15 at 2:00 PM Eastern")).toBe(true);
    expect(has("Thursday, October 15 at 2:00 PM")).toBe(false); // no zone
    expect(has("October 15 at 2:00 PM ET")).toBe(false); // no weekday
  });

  it("a second time doesn't borrow the first one's weekday (8c21660/TEST-104)", () => {
    const text = "Thursday, October 15 at 2:00 PM ET or October 16 at 3:00 PM ET";
    const [first, second] = dateTimeMentions(text);
    if (first === undefined || second === undefined) throw new Error("expected two mentions");
    expect(mentionHasWeekdayAndZone(text, first)).toBe(true);
    expect(mentionHasWeekdayAndZone(text, second, first)).toBe(false);
    const both = "Thursday, October 15 at 2:00 PM ET or Friday, October 16 at 3:00 PM ET";
    const [a, b] = dateTimeMentions(both);
    if (a === undefined || b === undefined) throw new Error("expected two mentions");
    expect(mentionHasWeekdayAndZone(both, b, a)).toBe(true);
  });
});
