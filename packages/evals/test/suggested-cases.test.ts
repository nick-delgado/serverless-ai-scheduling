/**
 * The format patterns of the cases #201 added from other PRs' suggestions (r1/Q-6 (a)), graded against the replies the
 * decisions quote: each pattern rejects the reply it was written for and accepts the replies it must let through.
 * `l1.response.format_must_match_none` is the check under test; `l1-opening-turn-one-detail` (S1, r1/Q-2 (a)),
 * `l1-offer-single-slot-lead-in` (T3, r1/A-4) and `l1-offer-closing-question-no-date` (T4, r1/A-4) carry one.
 */
import { describe, expect, it } from "vitest";

import { byName, l1Failures, l1Graded } from "./helpers";

const MATCH_NONE = "l1.response.format_must_match_none";

/** The status of `l1.response.format_must_match_none` for `text` as the reply to case `id`, or "absent". */
const status = (id: string, text: string): string =>
  byName(l1Graded(id, text), MATCH_NONE)?.status ?? "absent";

describe("S1 l1-opening-turn-one-detail fails a question that joins a second detail (r1/Q-2 (a))", () => {
  const ID = "l1-opening-turn-one-detail";

  /** Visit-word before provider-word: only the first pattern matches. */
  const VISIT_FIRST = [
    ["visit", "provider", "What is the visit for, and which provider?"],
    ["reason", "specialty", "What is the reason, and which specialty?"],
    ["brings you", "specialist", "What brings you in, and do you want a specialist?"],
    ["bring you", "doctor", "What would bring you in, and which doctor?"],
  ];
  /** Provider-word before visit-word: only the second pattern matches. */
  const PROVIDER_FIRST = [
    ["provider", "visit", "Which provider, and what is the visit for?"],
    ["specialty", "reason", "Which specialty, and what is the reason?"],
    ["specialist", "brings you", "Do you want a specialist, and what brings you in?"],
    ["doctor", "bring you", "Which doctor, and what would bring you in?"],
  ];

  it.each([...VISIT_FIRST, ...PROVIDER_FIRST])("rejects a question with %s and %s", (_a, _b, text) => {
    expect(status(ID, text)).toBe("fail");
  });

  it.each([
    "What is the visit for, and do you have a preferred provider or specialty?",
    "Do you have a preferred doctor, and what is the reason for the visit?",
    "Hi James. What brings you in, and is there a specialist you want to see?",
    "Do you have a preferred doctor, and what is the visit for?",
  ])("rejects %j", (text) => {
    expect(status(ID, text)).toBe("fail");
  });

  it.each([
    "What is the visit for, James?",
    "Which provider would you like to see?",
    "I can help you find the right provider. What brings you in?",
    "What is the reason for your visit?",
    "Once I know the reason for the visit, I can pick a provider.",
    "I can match you with a provider once I know the reason.",
  ])("accepts %j", (text) => {
    expect(status(ID, text)).toBe("pass");
  });
});

describe("T3 l1-offer-single-slot-lead-in fails a date repeated or crowded on the day line (r1/A-4)", () => {
  const ID = "l1-offer-single-slot-lead-in";
  const DAY_LINE = "Monday, October 19:\n- 10:00 AM ET\nWould that work?";

  it.each([
    ["the date in the lead-in too", `Dr. Haddad has 10:00 AM ET open on Monday, October 19.\n${DAY_LINE}`],
    ["the date again in the lead-in, without its weekday", `Dr. Haddad has October 19 open.\n${DAY_LINE}`],
    [
      "text before the date on the day line",
      "Dr. Haddad has 10:00 AM ET open on Monday, October 19:\n- 10:00 AM ET",
    ],
    ["a time on the day line", "Monday, October 19: 10:00 AM ET\nWould that work?"],
    [
      "the reply #319 quotes: the date after the weekday, no ET",
      `Dr. Haddad has 10:00 AM open on Monday, October 19.\n${DAY_LINE}`,
    ],
  ])("rejects %s", (_what, text) => {
    expect(status(ID, text)).toBe("fail");
  });

  it("accepts a lead-in that names the time with ET and a day line that stands alone", () => {
    expect(status(ID, `Dr. Haddad has 10:00 AM ET open that day:\n${DAY_LINE}`)).toBe("pass");
  });
});

describe("T4 l1-offer-closing-question-no-date fails a month-day inside a question (r1/A-4)", () => {
  const ID = "l1-offer-closing-question-no-date";
  const LIST = "Monday, October 19:\n- 10:00 AM ET\n- 10:30 AM ET\n";

  it.each([
    "Would Monday, October 19 at 10:00 AM ET work?",
    "Would Oct 19 at 10:00 AM ET work for you?",
    "Does October 19 suit you?",
  ])("rejects the question %j", (question) => {
    expect(status(ID, `${LIST}${question}`)).toBe("fail");
  });

  it.each([
    "Jan",
    "January",
    "Feb",
    "February",
    "Mar",
    "March",
    "Apr",
    "April",
    "May",
    "Jun",
    "June",
    "Jul",
    "July",
    "Aug",
    "August",
    "Sep",
    "Sept",
    "September",
    "Oct",
    "October",
    "Nov",
    "November",
    "Dec",
    "December",
  ])("rejects a question that names the month %s", (month) => {
    expect(status(ID, `${LIST}Would ${month} 5 work?`)).toBe("fail");
  });

  it("rejects a month with a period and a two-digit day", () => {
    expect(status(ID, `${LIST}Would Nov. 12 work?`)).toBe("fail");
  });

  it.each([
    "Would Monday at 10:00 AM ET work, or would you like to see other days?",
    "Would 10:00 AM ET work for you?",
  ])("accepts the question %j, with the day line on its own line", (question) => {
    expect(status(ID, `${LIST}${question}`)).toBe("pass");
  });

  it("accepts a day line that names the date and no question", () => {
    expect(status(ID, LIST)).toBe("pass");
  });
});

const ACTION = "l1.action";
const QUESTIONS = "l1.response.max_questions";
const FORBID = "l1.forbid_tools";
const ET = "invariant.times_in_clinic_tz_with_weekday";
const SLOTS = "invariant.no_hallucinated_slots";

describe("S2 l1-reason-known-one-question and S3 l1-time-missing-one-question allow one question (r1/Q-3 (a))", () => {
  const TWO = "When would you like to come in? Any day or time that works best for you?";
  const search = (specialty: string) => ({
    name: "check_availability",
    input: { specialty, date_range: { start_date: "2026-10-12", end_date: "2026-10-16" } },
  });

  it("S2 passes one question, of either kind, and fails two questions or a search", () => {
    const id = "l1-reason-known-one-question";
    expect(l1Failures(id, "Would you prefer family medicine or physical therapy for that?")).toEqual([]);
    expect(l1Failures(id, "When would you like to come in?")).toEqual([]);
    expect(l1Failures(id, TWO)).toEqual([QUESTIONS]);
    expect(l1Failures(id, "", [search("physical_therapy")])).toEqual([ACTION]);
  });

  it("S3 passes one question or a search for either specialty, and fails two questions, another specialty or a booking", () => {
    const id = "l1-time-missing-one-question";
    expect(
      l1Failures(id, "When would you like to come in: this week, next week, or a specific day?"),
    ).toEqual([]);
    expect(l1Failures(id, "", [search("family_medicine")])).toEqual([]);
    expect(l1Failures(id, "", [search("physical_therapy")])).toEqual([]);
    expect(
      l1Failures(id, "When would you like to come in? This week, next week, or a specific day?"),
    ).toEqual([QUESTIONS]);
    expect(l1Failures(id, "", [search("dermatology")])).toEqual([ACTION]);
    expect(l1Failures(id, "", [{ name: "book_appointment", input: {} }])).toEqual(
      expect.arrayContaining([FORBID]),
    );
  });
});

describe("T1 and T2 expect the search and grade the line before it for ET (r1/Q-1 (a), r1/A-2)", () => {
  const search = (start: string, end: string, extra: object = {}) => ({
    name: "check_availability",
    input: { provider_id: "prov_haddad", date_range: { start_date: start, end_date: end }, ...extra },
  });
  const THU = "l1-move-same-time-next-thursday";
  const WEEK = "l1-move-any-day-week-after-at-ten";
  const MONDAY = search("2026-10-19", "2026-10-19", { start_time: "10:00" });

  it("T1 passes the search for Thursday, October 22 and fails another date, another provider, or a write", () => {
    expect(l1Failures(THU, "", [search("2026-10-22", "2026-10-22")])).toEqual([]);
    expect(l1Failures(THU, "", [search("2026-10-15", "2026-10-15")])).toEqual([ACTION]);
    expect(
      l1Failures(THU, "", [
        {
          name: "check_availability",
          input: {
            provider_id: "prov_lee",
            date_range: { start_date: "2026-10-22", end_date: "2026-10-22" },
          },
        },
      ]),
    ).toEqual([ACTION]);
    for (const name of ["reschedule_appointment", "book_appointment"])
      expect(l1Failures(THU, "", [{ name, input: {} }]), name).toContain(FORBID);
  });

  it("T2 passes a Monday search at 10:00 among the week's calls and fails one with no start time, another date, no provider, or a write", () => {
    const tuesday = search("2026-10-20", "2026-10-20", { start_time: "10:00" });
    expect(l1Failures(WEEK, "", [MONDAY, tuesday])).toEqual([]);
    expect(l1Failures(WEEK, "", [search("2026-10-19", "2026-10-19")])).toEqual([ACTION]);
    expect(
      l1Failures(WEEK, "", [
        {
          name: "check_availability",
          input: { date_range: { start_date: "2026-10-19", end_date: "2026-10-19" }, start_time: "10:00" },
        },
      ]),
    ).toEqual([ACTION]);
    expect(l1Failures(WEEK, "", [search("2026-10-26", "2026-10-26", { start_time: "10:00" })])).toEqual([
      ACTION,
    ]);
    for (const name of ["reschedule_appointment", "book_appointment"])
      expect(l1Failures(WEEK, "", [{ name, input: {} }]), name).toContain(FORBID);
  });

  it.each([THU, WEEK])("%s fails a pre-tool line with a time that lacks ET and passes one with ET", (id) => {
    const call = id === THU ? [search("2026-10-22", "2026-10-22")] : [MONDAY];
    expect(l1Failures(id, "Let me check Thursday at 10:00 AM.", call)).toEqual([ET]);
    expect(l1Failures(id, "Let me check Thursday at 10:00 AM ET.", call)).toEqual([]);
    expect(l1Failures(id, "Let me check Dr. Haddad's openings that week.", call)).toEqual([]);
  });

  it("a pre-tool line that pairs a month-day with a time no tool returned fails no_hallucinated_slots", () => {
    expect(
      l1Failures(THU, "Let me check Thursday, October 22 at 10:00 AM ET.", [
        search("2026-10-22", "2026-10-22"),
      ]),
    ).toEqual([SLOTS]);
  });
});

describe("each new case's other checks (r1/Q-1 to Q-3, r1/A-3, r1/A-8)", () => {
  const SEARCH = { name: "check_availability", input: { specialty: "cardiology" } };
  const T3 = "l1-offer-single-slot-lead-in";
  const T4 = "l1-offer-closing-question-no-date";
  const GOOD_T3 =
    "Dr. Haddad has 10:00 AM ET open that day:\nMonday, October 19:\n- 10:00 AM ET\nWould that work?";
  const GOOD_T4 =
    "Monday, October 19:\n- 10:00 AM ET\n- 10:30 AM ET\n- 11:00 AM ET\nWould Monday at 10:00 AM ET work, or would you like to see other days?";

  it.each(["l1-opening-turn-one-detail", "l1-reason-known-one-question", "l1-time-missing-one-question"])(
    "%s fails one question mark more than one, and each write or escalation",
    (id) => {
      expect(l1Failures(id, "What is the visit for? And which provider?")).toEqual([QUESTIONS]);
      for (const name of ["book_appointment", "reschedule_appointment", "escalate_to_human"])
        expect(l1Failures(id, "", [{ name, input: {} }]), name).toContain(FORBID);
    },
  );

  it("T3 passes a single-slot offer with ET, and fails one without its day line or its ET", () => {
    expect(l1Failures(T3, GOOD_T3)).toEqual([]);
    expect(l1Failures(T3, GOOD_T3.replace("Monday, October 19:", "Monday:"))).toContain(
      "l1.response.contains_all",
    );
    expect(l1Failures(T3, GOOD_T3.replace("- 10:00 AM ET", "- 10:00 AM"))).toEqual([ET]);
    expect(l1Failures(T3, GOOD_T3.replaceAll("10:00 AM ET", "10:00"))).toContain("l1.response.contains_all");
    expect(l1Failures(T3, "", [SEARCH])).toContain(ACTION);
  });

  it("T4 passes an offer whose closing question has no month-day, and fails a time with no ET or a tool call", () => {
    expect(l1Failures(T4, GOOD_T4)).toEqual([]);
    expect(l1Failures(T4, GOOD_T4.replace("at 10:00 AM ET work", "at 10:00 AM work"))).toEqual([ET]);
    expect(l1Failures(T4, GOOD_T4.replace("- 10:30 AM ET", "- 10:30 AM"))).toEqual([ET]);
    expect(l1Failures(T4, "", [SEARCH])).toContain(ACTION);
  });
});
