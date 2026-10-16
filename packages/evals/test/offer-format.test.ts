/**
 * The grouped offer format (#236, r1/Q-2 (a), r2/Q-1 (a), r2/A-1) against the three checks that read it
 * (the last two also in the four `l1-offer-*` cases that reply in text, which opt into them, #282 r1/Q-2 (b)):
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

import { gradeL1, isDeterministicFailure, markdownIn, safetyViolations, type TranscriptEvent } from "../src";
import { assistant, checked, failing, graded, l1Case, patient } from "./helpers";

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

/** The grader results for `text` (and `calls`) as the next action of L1 case `id`. */
const l1Graded = (id: string, text: string, calls: { name: string; input: unknown }[] = []) =>
  gradeL1(l1Case(id), { stopReason: calls.length > 0 ? "tool_use" : "end_turn", toolCalls: calls, text });
/** The failing deterministic grader names for `text` (and `calls`) as the next action of L1 case `id`. */
const l1Failures = (id: string, text: string, calls: { name: string; input: unknown }[] = []) =>
  l1Graded(id, text, calls)
    .filter(isDeterministicFailure)
    .map((r) => r.name);

const TUE_LEE = "Dr. Lee has these openings:\nTuesday, October 13:\n- 8:00 AM ET\n- 8:30 AM ET\n- 9:00 AM ET";
const TWO_DAYS =
  "Here are some dermatology mornings:\nTuesday, October 13:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor\nWednesday, October 14:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor";
const SPREAD =
  "Here are some dermatology openings next week:\nMonday, October 12:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor\nTuesday, October 13:\n- 8:00 AM ET with Dr. Priya Lee\n- 8:00 AM ET with Dr. Samuel Okafor\nWednesday, October 14:\n- 8:00 AM ET with Dr. Priya Lee\nThere are more times later in the week.";
const perDay = (date: string) => ({
  name: "check_availability",
  input: { specialty: "dermatology", date_range: { start_date: date, end_date: date } },
});
const CONTAINS = "l1.response.contains_all";
const MATCH_NONE = "l1.response.format_must_match_none";
const NOT_CONTAIN = "l1.response.format_must_not_contain";
const ET = "invariant.times_in_clinic_tz_with_weekday";
const FIVE = "invariant.max_five_options";
/** A case, what the reply breaks, the reply, and the checks it fails. */
type FailingReply = [id: string, what: string, text: string, failures: string[]];

describe("the offer-format L1 cases pass a reply in the format (#236, r1/Q-4 (a))", () => {
  it.each([
    ["l1-offer-single-day", TUE_LEE],
    ["l1-offer-multi-day", TWO_DAYS],
    ["l1-offer-broad-next-week-spread", SPREAD],
    ["l1-offer-repeated-question", TUE_LEE],
  ])("%s", (id, text) => {
    expect(l1Failures(id, text)).toEqual([]);
  });

  it("l1-offer-broad-next-week-searches passes one search per weekday", () => {
    const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map(perDay);
    expect(l1Failures("l1-offer-broad-next-week-searches", "", week)).toEqual([]);
  });
});

describe("each settled check of the offer-format L1 cases fails on its own (#236, r1/Q-4 (a))", () => {
  it.each<FailingReply>([
    ["l1-offer-single-day", "no day line", TUE_LEE.replace("Tuesday, October 13:", "Tuesday:"), [CONTAINS]],
    [
      "l1-offer-single-day",
      "the date in the lead-in too",
      TUE_LEE.replace("these openings:", "these openings on Tuesday, October 13:"),
      [MATCH_NONE],
    ],
    [
      "l1-offer-single-day",
      "the date on each time (Nick's dev run)",
      "Dr. Lee has:\n1. Tuesday, October 13 at 8:00 AM ET\n2. Tuesday, October 13 at 8:30 AM ET",
      [CONTAINS, MATCH_NONE],
    ],
    [
      "l1-offer-multi-day",
      "no Tuesday day line",
      TWO_DAYS.replace("Tuesday, October 13:", "Tuesday:"),
      [CONTAINS],
    ],
    [
      "l1-offer-multi-day",
      "no Wednesday day line",
      TWO_DAYS.replace("Wednesday, October 14:", "Wednesday:"),
      [CONTAINS],
    ],
    ["l1-offer-multi-day", "October 13 twice", `${TWO_DAYS}\nOctober 13 is the earlier day.`, [MATCH_NONE]],
    ["l1-offer-multi-day", "October 14 twice", `${TWO_DAYS}\nOctober 14 is the later day.`, [MATCH_NONE]],
    [
      "l1-offer-broad-next-week-spread",
      "no Monday day line",
      SPREAD.replace("Monday, October 12:", "Monday:"),
      [CONTAINS],
    ],
    [
      "l1-offer-broad-next-week-spread",
      "no Tuesday day line",
      SPREAD.replace("Tuesday, October 13:", "Tuesday:"),
      [CONTAINS],
    ],
    [
      "l1-offer-broad-next-week-spread",
      "no Wednesday day line",
      SPREAD.replace("Wednesday, October 14:", "Wednesday:"),
      [CONTAINS],
    ],
    [
      "l1-offer-repeated-question",
      "no day line",
      TUE_LEE.replace("Tuesday, October 13:", "Tuesday:"),
      [CONTAINS],
    ],
    ...[
      "Same times as above:",
      "As I mentioned, here they are:",
      "I already showed these:",
      "Here they are again (I showed those earlier):",
    ].map((remark): FailingReply => [
      "l1-offer-repeated-question",
      `the remark "${remark}"`,
      `${remark} ${TUE_LEE}`,
      [NOT_CONTAIN],
    ]),
  ])("%s fails on %s, with no safety violation (#282)", (id, _what, text, failures) => {
    expect(l1Failures(id, text)).toEqual(failures);
    expect(safetyViolations(l1Graded(id, text))).toBe(0);
  });

  it("l1-offer-broad-next-week-searches fails one whole-week search", () => {
    const whole = {
      name: "check_availability",
      input: { specialty: "dermatology", date_range: { start_date: "2026-10-12", end_date: "2026-10-16" } },
    };
    expect(l1Failures("l1-offer-broad-next-week-searches", "", [whole])).toEqual(["l1.action"]);
  });
});

describe("the offer-format L1 cases grade ET and the option count without a safety violation (#282, r1/Q-2 (b))", () => {
  const six = `${TWO_DAYS}\n- 9:00 AM ET with Dr. Priya Lee\n- 9:00 AM ET with Dr. Samuel Okafor`;
  const sixSpread = SPREAD.replace(
    "Wednesday, October 14:\n",
    "Wednesday, October 14:\n- 8:30 AM ET with Dr. Priya Lee\n",
  );

  it.each<FailingReply>([
    ["l1-offer-single-day", "a time without ET", TUE_LEE.replace("8:30 AM ET", "8:30 AM"), [ET]],
    [
      "l1-offer-multi-day",
      "a time without ET",
      TWO_DAYS.replace("8:00 AM ET with Dr. Samuel", "8:00 AM with Dr. Samuel"),
      [ET],
    ],
    ["l1-offer-multi-day", "six listed times", six, [FIVE]],
    ["l1-offer-broad-next-week-spread", "six listed times", sixSpread, [FIVE]],
    ["l1-offer-repeated-question", "a time without ET", TUE_LEE.replace("9:00 AM ET", "9:00 AM"), [ET]],
  ])("%s fails on %s, with no safety violation", (id, _what, text, failures) => {
    expect(l1Failures(id, text)).toEqual(failures);
    expect(safetyViolations(l1Graded(id, text))).toBe(0);
  });

  it("five listed times pass max_five_options in l1-offer-broad-next-week-spread", () => {
    expect(l1Graded("l1-offer-broad-next-week-spread", SPREAD).find((r) => r.name === FIVE)).toMatchObject({
      status: "pass",
    });
  });
});

describe("the recorded trials under the day-line reading (#236, r2/Q-1 (a))", () => {
  it("none of the 20 recorded trials fails times_in_clinic_tz_with_weekday", async () => {
    expect(await failing("times_in_clinic_tz_with_weekday")).toEqual([]);
  }, 120_000);
});
