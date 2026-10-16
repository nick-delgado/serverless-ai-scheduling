/**
 * The grouped offer format (#236, r1/Q-2 (a), r2/Q-1 (a), r2/A-1) against the three checks that read it:
 * - `no_hallucinated_slots` dates a listed time by the day line above it (#239's `headingListTimes`);
 * - `times_in_clinic_tz_with_weekday` takes that time's weekday from the day line, and wants ET on the
 *   time's own line, within 16 characters after it;
 * - `max_five_options` counts the listed times across all day lines (#212: five in total, not five per day).
 *
 * Gate run 4's heading ("Tuesday, October 13 (earlier than your 2:30 PM visit):"), which #239 handed to this
 * issue, is tested in `no-hallucinated-slots.test.ts` (Q-1 (a)): it still fails the weekday check on its own
 * 2:30 PM, because a day line carries no time.
 */
import { describe, expect, it } from "vitest";

import { gradeL1, markdownIn, trialPassed, type TranscriptEvent } from "../src";
import { assistant, checked, graded, l1Case, patient } from "./helpers";

const MARIA_SCENARIO = "book-derm-next-week-afternoon";

/** Dr. Lee and Dr. Okafor, Tue Oct 13 and Wed Oct 14, 1:00 to 2:00 PM EDT. */
const RESULTS = checked(
  "lee@2026-10-13T17:00:00Z",
  "lee@2026-10-13T17:30:00Z",
  "okafor@2026-10-13T17:30:00Z",
  "lee@2026-10-14T17:00:00Z",
  "lee@2026-10-14T17:30:00Z",
  "lee@2026-10-14T18:00:00Z",
);

const ONE_PROVIDER =
  "Dr. Lee has these openings:\nTuesday, October 13:\n- 1:00 PM ET\n- 1:30 PM ET\n\nWednesday, October 14:\n- 1:00 PM ET\n- 1:30 PM ET\n- 2:00 PM ET\nWould one of these work?";
const TWO_PROVIDERS =
  "Here are some dermatology afternoons:\nTuesday, October 13:\n- 1:00 PM ET with Dr. Priya Lee\n- 1:30 PM ET with Dr. Priya Lee\n- 1:30 PM ET with Dr. Samuel Okafor\nWednesday, October 14:\n- 1:00 PM ET with Dr. Priya Lee\n- 1:30 PM ET with Dr. Priya Lee";

const reply = (text: string): TranscriptEvent[] => [
  patient("Any dermatology afternoons next week?"),
  RESULTS,
  assistant(text),
];

/** `invariant.times_in_clinic_tz_with_weekday` on one reply after `RESULTS`. */
const weekdayCheck = (text: string) => graded(MARIA_SCENARIO, reply(text), "times_in_clinic_tz_with_weekday");

describe("a grouped offer passes the format checks (#236, r1/Q-2 (a))", () => {
  it.each([
    ["one provider, named once before the list", ONE_PROVIDER],
    ["two providers, one named on each time line", TWO_PROVIDERS],
  ])("%s", async (_name, text) => {
    for (const name of ["no_hallucinated_slots", "times_in_clinic_tz_with_weekday", "max_five_options"])
      expect(await graded(MARIA_SCENARIO, reply(text), name), name).toMatchObject({ status: "pass" });
    expect(markdownIn(text)).toBeUndefined();
  });
});

describe("each check fails on a grouped offer that breaks it (#236, AC 4)", () => {
  it("no_hallucinated_slots fails on a listed time no tool returned", async () => {
    expect(
      await graded(MARIA_SCENARIO, reply(ONE_PROVIDER.replace("- 2:00 PM ET", "- 3:00 PM ET"))),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("October 14 … 3:00 PM") as unknown });
  });

  it("max_five_options counts six listed times across two day lines as six (#212)", async () => {
    const six = ONE_PROVIDER.replace("- 1:30 PM ET\n\n", "- 1:30 PM ET\n- 2:00 PM ET\n\n");
    expect(await graded(MARIA_SCENARIO, reply(six), "max_five_options")).toMatchObject({
      status: "fail",
      detail: "6 times in one message",
    });
  });

  it("times_in_clinic_tz_with_weekday fails on a listed time without ET", async () => {
    expect(await weekdayCheck(ONE_PROVIDER.replace("- 2:00 PM ET", "- 2:00 PM"))).toMatchObject({
      status: "fail",
      detail: '"October 14 … 2:00 PM" lacks a weekday or ET',
    });
  });

  it("times_in_clinic_tz_with_weekday fails on a day line without a weekday, even with one in the line before", async () => {
    expect(
      await weekdayCheck("Dr. Lee has these openings on Tuesday:\nOctober 13:\n- 1:00 PM ET\n- 1:30 PM ET"),
    ).toMatchObject({ status: "fail", detail: '"October 13 … 1:00 PM" lacks a weekday or ET' });
  });
});

describe("times_in_clinic_tz_with_weekday reads ET on the listed time's own line, within 16 characters (r2/Q-1 (a))", () => {
  it("passes ET that ends at the 16th character after the time", async () => {
    expect(await weekdayCheck("Tuesday, October 13:\n- 1:00 PM for Dr. Lee, ET")).toMatchObject({
      status: "pass",
    });
  });

  it("fails ET that ends at the 17th character after the time", async () => {
    expect(await weekdayCheck("Tuesday, October 13:\n- 1:00 PM with Dr. Lee, ET")).toMatchObject({
      status: "fail",
      detail: '"October 13 … 1:00 PM" lacks a weekday or ET',
    });
  });

  it("fails a time whose ET is only on the next list line", async () => {
    expect(await weekdayCheck("Tuesday, October 13:\n- 1:00 PM\n- 1:30 PM ET")).toMatchObject({
      status: "fail",
      detail: '"October 13 … 1:00 PM" lacks a weekday or ET',
    });
  });
});

describe("times_in_clinic_tz_with_weekday leaves out what isn't a listed time (r1/Q-2 (a) edges)", () => {
  it("doesn't grade a list after a prose line, which ends the day line's reach", async () => {
    expect(await weekdayCheck("Tuesday, October 13:\nHere they are:\n- 1:00 PM")).toMatchObject({
      status: "pass",
    });
  });

  it("doesn't grade a later time in a sentence: only the slot check dates it", async () => {
    expect(
      await weekdayCheck("Dr. Lee has Tuesday, October 13 at 1:00 PM ET and 1:30 PM. Would either work?"),
    ).toMatchObject({ status: "pass" });
  });
});

/** The failing grader names for `text` (and `calls`) as the next action of L1 case `id`. */
const l1Failures = (id: string, text: string, calls: { name: string; input: unknown }[] = []) => {
  const results = gradeL1(l1Case(id), {
    stopReason: calls.length > 0 ? "tool_use" : "end_turn",
    toolCalls: calls,
    text,
  });
  return trialPassed(results) ? [] : results.filter((r) => r.status === "fail").map((r) => r.name);
};

const TUE_LEE = "Dr. Lee has these openings:\nTuesday, October 13:\n- 8:00 AM ET\n- 8:30 AM ET\n- 9:00 AM ET";
const TWO_DAYS =
  "Here are some dermatology mornings:\nTuesday, October 13:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor\nWednesday, October 14:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor";
const SPREAD =
  "Here are some dermatology openings next week:\nMonday, October 12:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor\nTuesday, October 13:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor\nWednesday, October 14:\n- 8:00 AM ET with Dr. Priya Lee\nThere are more times later in the week.";
const perDay = (date: string) => ({
  name: "check_availability",
  input: { specialty: "dermatology", date_range: { start_date: date, end_date: date } },
});

describe("the offer-format L1 cases pass a reply in the format and fail the old one (#236, r1/Q-4 (a))", () => {
  it("l1-offer-single-day", () => {
    expect(l1Failures("l1-offer-single-day", TUE_LEE)).toEqual([]);
    expect(
      l1Failures(
        "l1-offer-single-day",
        "Dr. Lee has:\n1. Tuesday, October 13 at 8:00 AM ET\n2. Tuesday, October 13 at 8:30 AM ET",
      ),
    ).toEqual(["l1.response.contains_all", "l1.response.must_match_none"]);
    expect(l1Failures("l1-offer-single-day", TUE_LEE.replace("8:30 AM ET", "8:30 AM"))).toEqual([
      "l1.response.must_match_none",
    ]);
  });

  it("l1-offer-multi-day", () => {
    expect(l1Failures("l1-offer-multi-day", TWO_DAYS)).toEqual([]);
    expect(
      l1Failures(
        "l1-offer-multi-day",
        `${TWO_DAYS}\n- 9:00 AM ET with Dr. Priya Lee\n- 9:00 AM ET with Dr. Samuel Okafor`,
      ),
    ).toEqual(["l1.response.must_match_none"]);
  });

  it("l1-offer-broad-next-week-searches", () => {
    const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map(perDay);
    expect(l1Failures("l1-offer-broad-next-week-searches", "", week)).toEqual([]);
    const whole = {
      name: "check_availability",
      input: { specialty: "dermatology", date_range: { start_date: "2026-10-12", end_date: "2026-10-16" } },
    };
    expect(l1Failures("l1-offer-broad-next-week-searches", "", [whole])).toEqual(["l1.action"]);
  });

  it("l1-offer-broad-next-week-spread", () => {
    expect(l1Failures("l1-offer-broad-next-week-spread", SPREAD)).toEqual([]);
    const bunched =
      "Here are the earliest openings:\nMonday, October 12:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor\n- 8:30 AM ET with Dr. Priya Lee";
    expect(l1Failures("l1-offer-broad-next-week-spread", bunched)).toEqual(["l1.response.contains_all"]);
  });

  it("l1-offer-repeated-question", () => {
    expect(l1Failures("l1-offer-repeated-question", TUE_LEE)).toEqual([]);
    expect(l1Failures("l1-offer-repeated-question", `I just showed those above! ${TUE_LEE}`)).toEqual([
      "l1.response.must_not_contain",
    ]);
  });
});
