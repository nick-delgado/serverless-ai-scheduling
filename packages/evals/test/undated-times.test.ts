/**
 * `times_in_clinic_tz_with_weekday` on the clock times no pair or day line claims (#320, `unclaimedTimes`):
 * - which times (r1/Q-1 (a)): every "h:mm AM/PM" time that isn't a `dateTimeMentions` pair's own time or a
 *   list-line time under a date heading, wherever it is;
 * - what each needs (r1/Q-2 (c)): ET within 16 characters after it (or after its range end), and a weekday or
 *   "that day" in its sentence, unless it is a bound (#337 r1/Q-3 (b): "and later" and "and earlier" too) or a
 *   several-day phrase its text's day lines back (#337 r1/Q-2 (c); "next week", "both days" and "each of
 *   those days" added by #340, r1/Q-1 (c) and r1/Q-2 (a)); a pre-tool line without a day line needs ET only
 *   (#337 r1/Q-1 (b));
 * - what counts as a time (r1/Q-4 (a)): "h:mm AM/PM" only.
 * The sentences of #326's and #332's runs are fixtures too (#337, A-3), and so are #339's two gate-run sentences (#340,
 * A-2), placed as they were in their trials.
 * #360 (r1/Q-1 to Q-5): an hours remark (the last start of a visit after a latest-slot phrase, or an opening or
 * closing hour after a clinic-hours lead) needs ET only; a one-date text's closing question needs ET only, its day
 * line naming the day; "between 8:00 AM and 5:00 PM ET" is a range. #345's eight failing trials are fixtures, whole.
 * The 12 sentences of #293's hand count (results comment on #293, 2026-10-17) are fixtures, placed as they were in
 * the trial, and so are `system.v9`'s own compliant examples. Pairs and day-line times keep their rule (A-2):
 * `offer-format.test.ts`.
 * "the prompt's bound sentence (#328)" compares `BOUND_WORDS` and `BOUND_AFTER_TAILS` with the bound words and
 * "ET or <tail>" forms quoted in `buildSystemPrompt(...).stable`.
 */
import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@sched/agent";

import {
  BOUND_AFTER_TAILS,
  BOUND_WORDS,
  headingListTimes,
  slotMentions,
  unclaimedTimeLacks,
  unclaimedTimes,
} from "../src/graders/text";
import type { TranscriptEvent } from "../src";
import { assistant, call, checked, graded, inTurn, patient } from "./helpers";

const SCENARIO = "clarify-two-requests-one-message";
/** Dr. Haddad, Monday to Friday, October 19 to 23, 10:00 AM EDT. */
const HADDAD_10AM = checked(
  "haddad@2026-10-19T14:00:00Z",
  "haddad@2026-10-20T14:00:00Z",
  "haddad@2026-10-21T14:00:00Z",
  "haddad@2026-10-22T14:00:00Z",
  "haddad@2026-10-23T14:00:00Z",
);
const ASKS = patient("I'd like to move it to the week of October 19th, same time, 10:00 AM. Any day works.");

/** `invariant.times_in_clinic_tz_with_weekday` on `events`. */
const timesCheck = (events: readonly TranscriptEvent[]) =>
  graded(SCENARIO, events, "times_in_clinic_tz_with_weekday");
/** The check on one assistant text, as the turn's only text. */
const onText = (text: string) => timesCheck([ASKS, assistant(text)]);
/** The detail the check gives when `time` in `sentence` lacks `what`. */
const lacks = (time: string, what: string, sentence: string) => `"${time}" lacks ${what}, in "${sentence}"`;
const WEEKDAY = 'a weekday or "that day"';

describe("#293's hand count: each sentence, placed as it was in the trial (E-3)", () => {
  const preTool: [run: string, sentence: string][] = [
    ["run 1, trial 1", "Let me check Dr. Haddad's availability at 10:00 AM the week of October 19–23."],
    ["run 1, trial 2", "Let me check Dr. Haddad's availability at 10:00 AM that week."],
    ["run 1, trial 3", "Let me check Dr. Haddad's availability at 10:00 AM that week."],
    ["run 2, trial 1", "Let me check Dr. Haddad's availability at 10:00 AM that week."],
    ["run 2, trial 3", "Let me check Dr. Haddad's 10:00 AM availability across that week."],
  ];
  it.each(preTool)("%s: the pre-tool line fails on ET", async (_run, sentence) => {
    expect(await timesCheck([ASKS, assistant(sentence), HADDAD_10AM])).toMatchObject({
      status: "fail",
      detail: lacks("10:00 AM", "ET", sentence),
    });
  });

  const offers: [run: string, sentence: string, message: string][] = [
    [
      "run 1, trial 1 (lead-in)",
      "Dr. Haddad has a 10:00 AM slot available that week:",
      "Dr. Haddad has a 10:00 AM slot available that week:\n\nMonday, October 19:\n- 10:00 AM ET\n\nMore days may be available if you'd like to see them. Would Monday, October 19 at 10:00 AM ET work, or would you prefer a different day?",
    ],
    [
      "run 1, trial 2 (lead-in)",
      "Dr. Haddad has a 10:00 AM opening that week:",
      "Dr. Haddad has a 10:00 AM opening that week:\n\nMonday, October 19:\n- 10:00 AM ET\n\nMore times are available later that week if you'd like. Would Monday, October 19 at 10:00 AM ET work?",
    ],
    [
      "run 1, trial 3 (a single-time sentence, no list)",
      "Dr. Haddad has 10:00 AM open on Monday, October 19.",
      "Dr. Haddad has 10:00 AM open on Monday, October 19. Would you like to move your appointment to that day, or would you prefer a different day that week?",
    ],
    [
      "run 2, trial 1 (lead-in)",
      "Dr. Haddad has 10:00 AM open on Monday, October 19.",
      "Dr. Haddad has 10:00 AM open on Monday, October 19. Here is that option:\n\nMonday, October 19:\n- 10:00 AM ET\n\nJust to confirm before I make the change: I'll move your appointment with Dr. Omar Haddad from Thursday, October 15, 2026 at 10:00 AM ET to Monday, October 19, 2026 at 10:00 AM ET at 400 Cedar Ridge Pkwy, for your blood pressure follow-up. Shall I go ahead?",
    ],
    [
      "run 2, trial 3 (lead-in)",
      "Dr. Haddad has 10:00 AM open every day that week.",
      "Dr. Haddad has 10:00 AM open every day that week. Here are your options:\n\nMonday, October 19:\n- 10:00 AM ET\n\nTuesday, October 20:\n- 10:00 AM ET\n\nWednesday, October 21:\n- 10:00 AM ET\n\nThursday, October 22:\n- 10:00 AM ET\n\nFriday, October 23:\n- 10:00 AM ET\n\nWhich day would you prefer, Walter?",
    ],
  ];
  it.each(offers)("%s fails on ET", async (_run, sentence, message) => {
    expect(message.startsWith(sentence)).toBe(true);
    expect(await timesCheck([ASKS, HADDAD_10AM, assistant(message)])).toMatchObject({
      status: "fail",
      detail: lacks("10:00 AM", "ET", sentence),
    });
  });

  it.each([
    ["run 1, trial 1", "Would Monday, October 19 at 10:00 AM ET work, or would you prefer a different day?"],
    ["run 1, trial 2", "Would Monday, October 19 at 10:00 AM ET work?"],
  ])("%s: the dated closing question passes, after the day line (r1/A-3)", async (_run, closing) => {
    const message = `Monday, October 19:\n- 10:00 AM ET\n\n${closing}`;
    expect(await timesCheck([ASKS, HADDAD_10AM, assistant(message)])).toMatchObject({ status: "pass" });
  });
});

describe("system.v9's own compliant examples pass (E-3)", () => {
  it.each([
    "Let me check Thursday at 10:00 AM ET.",
    "Let me check Monday to Friday next week at 10:00 AM ET.",
  ])("the pre-tool line %j", async (line) => {
    expect(await timesCheck([ASKS, assistant(line), HADDAD_10AM])).toMatchObject({ status: "pass" });
  });

  it.each([
    "Monday, October 19:\n- 10:00 AM ET\nWould Monday at 10:00 AM ET work, or would you like to see other days?",
    "Here are Dr. Haddad's openings that day from 1:00 PM ET:\nMonday, October 19:\n- 1:00 PM ET\n- 1:30 PM ET",
    "Dr. Haddad has 10:00 AM ET open that day:\nMonday, October 19:\n- 10:00 AM ET",
  ])("the offer %j", async (message) => {
    expect(await timesCheck([ASKS, HADDAD_10AM, assistant(message)])).toMatchObject({ status: "pass" });
  });

  it('whatever is settled, "Let me check Thursday at 10:00 AM." before a check_availability call fails', async () => {
    expect(
      await timesCheck([ASKS, assistant("Let me check Thursday at 10:00 AM."), HADDAD_10AM]),
    ).toMatchObject({
      status: "fail",
      detail: lacks("10:00 AM", "ET", "Let me check Thursday at 10:00 AM."),
    });
  });
});

/** A rule, a text with ET present that passes it, and one that fails it, with the time and what it lacks. */
type RulePair = [rule: string, passes: string, fails: string, time: string, what: string, sentence: string];

describe("each rule, with ET present, passes one fixture and fails another (E-3: r1/Q-1, Q-2 and Q-4, with #320's readings that 0cdd23a/SPEC-1 (a) and SPEC-4 (a) accepted)", () => {
  it.each<RulePair>([
    [
      "a later time in a sentence is graded (r1/Q-1 (a), reversing #236's reading)",
      "Dr. Lee has Tuesday, October 13 at 1:00 PM ET and 1:30 PM ET.",
      "Dr. Lee has Tuesday, October 13 at 1:00 PM ET and 1:30 PM.",
      "1:30 PM",
      "ET",
      "Dr. Lee has Tuesday, October 13 at 1:00 PM ET and 1:30 PM.",
    ],
    [
      "the other times on a day line are graded",
      "Tuesday, October 13: 8:00 AM ET, 8:30 AM ET, 9:00 AM ET",
      "Tuesday, October 13: 8:00 AM ET, 8:30 AM, 9:00 AM, 9:30 AM ET",
      "8:30 AM",
      "ET",
      "Tuesday, October 13: 8:00 AM ET, 8:30 AM, 9:00 AM, 9:30 AM ET",
    ],
    [
      "a list line outside a day line's reach takes its weekday from its own sentence",
      "Here they are:\n- Tuesday at 1:00 PM ET",
      "Tuesday:\n- 1:00 PM ET",
      "1:00 PM",
      WEEKDAY,
      "- 1:00 PM ET",
    ],
    [
      "a prose line ends a day line's reach, so the list after it is graded on its own",
      "Tuesday, October 13:\nHere they are, on Tuesday:\n- Tuesday 1:00 PM ET",
      "Tuesday, October 13:\nHere they are:\n- 1:00 PM ET",
      "1:00 PM",
      WEEKDAY,
      "- 1:00 PM ET",
    ],
    [
      "a weekday after the time counts (a time before its date)",
      "Dr. Haddad has 10:00 AM ET open on Monday, October 19.",
      "Dr. Haddad has 10:00 AM ET open on October 19.",
      "10:00 AM",
      WEEKDAY,
      "Dr. Haddad has 10:00 AM ET open on October 19.",
    ],
    [
      'the period of "Dr." ends no sentence, so a weekday before it counts',
      "On Monday, Dr. Haddad has 10:00 AM ET open.",
      "On Monday. Haddad has 10:00 AM ET open.",
      "10:00 AM",
      WEEKDAY,
      "Haddad has 10:00 AM ET open.",
    ],
    [
      'the periods inside "10:00 a.m." end no sentence',
      "Monday has 9:00 a.m. ET, 1:00 p.m. ET and 1:30 PM ET.",
      "Dr. Haddad has 10:00 a.m. ET. Monday is full.",
      "10:00 a.m.",
      WEEKDAY,
      "Dr. Haddad has 10:00 a.m. ET.",
    ],
    [
      "a semicolon ends a sentence",
      "Monday works, and 10:00 AM ET is open.",
      "Monday works; 10:00 AM ET is open.",
      "10:00 AM",
      WEEKDAY,
      "10:00 AM ET is open.",
    ],
    [
      "a question mark ends a sentence",
      "Is Monday good, at 10:00 AM ET?",
      "Is Monday good? 10:00 AM ET is open.",
      "10:00 AM",
      WEEKDAY,
      "10:00 AM ET is open.",
    ],
    [
      "an exclamation mark ends a sentence",
      "Good news, Monday has 10:00 AM ET!",
      "Good news, Monday! 10:00 AM ET is open.",
      "10:00 AM",
      WEEKDAY,
      "10:00 AM ET is open.",
    ],
    [
      "a newline ends a sentence",
      "Monday has 10:00 AM ET open.",
      "Monday is good\n10:00 AM ET is open",
      "10:00 AM",
      WEEKDAY,
      "10:00 AM ET is open",
    ],
    [
      'several times in a sentence share its weekday; "that week" is no weekday',
      "Monday at 9:00 AM ET or 10:00 AM ET.",
      "Let me check Dr. Haddad's availability at 10:00 AM ET that week.",
      "10:00 AM",
      WEEKDAY,
      "Let me check Dr. Haddad's availability at 10:00 AM ET that week.",
    ],
    [
      '"that day", any case, stands for a weekday; "every day" doesn\'t',
      "Dr. Haddad has 10:00 AM ET open That Day.",
      "Dr. Haddad has 10:00 AM ET open every day that week.",
      "10:00 AM",
      WEEKDAY,
      "Dr. Haddad has 10:00 AM ET open every day that week.",
    ],
    [
      'a weekday range names a weekday; "weekdays" doesn\'t',
      "Dr. Haddad has 10:00 AM ET open Mon–Fri.",
      "Dr. Haddad has 10:00 AM ET open on weekdays.",
      "10:00 AM",
      WEEKDAY,
      "Dr. Haddad has 10:00 AM ET open on weekdays.",
    ],
    [
      '"the same day" and "today" are no weekday',
      "Monday has 10:00 AM ET open the same day.",
      "Today has 10:00 AM ET open the same day.",
      "10:00 AM",
      WEEKDAY,
      "Today has 10:00 AM ET open the same day.",
    ],
    [
      "a range start takes its range end's ET",
      "We're open Monday to Friday, 8:00 AM to 5:00 PM Eastern Time.",
      "We're open Monday to Friday, 8:00 AM, staying open until 5:00 PM Eastern Time.",
      "8:00 AM",
      "ET",
      "We're open Monday to Friday, 8:00 AM, staying open until 5:00 PM Eastern Time.",
    ],
    [
      "a list time needs its own ET: its window stops at the next clock time (0cdd23a/SPEC-1 (a))",
      "Monday has 9:30 AM ET or 10:00 AM ET.",
      "Monday has 9:30 AM, 10:00 AM ET.",
      "9:30 AM",
      "ET",
      "Monday has 9:30 AM, 10:00 AM ET.",
    ],
    [
      "a range end's ET window stops at the next clock time too (0cdd23a/SPEC-1 (a))",
      "We're open Monday, 8:00 AM to 5:00 PM Eastern Time, and 6:00 PM ET on Friday.",
      "We're open Monday, 8:00 AM to 5:00 PM, 6:00 PM ET.",
      "8:00 AM",
      "ET",
      "We're open Monday, 8:00 AM to 5:00 PM, 6:00 PM ET.",
    ],
    [
      "ET may end at the 16th character after the time, with no other clock time in the window",
      "Monday has 10:00 AM for Dr. Lee, ET.",
      "Monday has 10:00 AM with Dr. Lee, ET.",
      "10:00 AM",
      "ET",
      "Monday has 10:00 AM with Dr. Lee, ET.",
    ],
    [
      "a bound needs ET only; another lead-in word needs a weekday",
      "Dr. Haddad has mornings (before 12:00 PM ET) that week.",
      "Dr. Haddad has mornings (around 12:00 PM ET) that week.",
      "12:00 PM",
      WEEKDAY,
      "Dr. Haddad has mornings (around 12:00 PM ET) that week.",
    ],
    [
      '"or later" after the ET makes a bound; "or so" doesn\'t',
      "Anything at 2:00 PM ET or later works that week.",
      "Anything at 2:00 PM ET or so, or 3:00 PM ET or later, works that week.",
      "2:00 PM",
      WEEKDAY,
      "Anything at 2:00 PM ET or so, or 3:00 PM ET or later, works that week.",
    ],
    [
      "a bound still needs ET",
      "Here are openings that week after 2:00 PM ET.",
      "Here are openings that week after 2:00 PM.",
      "2:00 PM",
      "ET",
      "Here are openings that week after 2:00 PM.",
    ],
    [
      '"h AM" is no clock time (r1/Q-4 (a)), so only "h:mm AM" is graded',
      "Let me check at 10 AM ET that week.",
      "Let me check at 10:00 AM ET that week.",
      "10:00 AM",
      WEEKDAY,
      "Let me check at 10:00 AM ET that week.",
    ],
  ])("%s", async (_rule, passes, fails, time, what, sentence) => {
    expect(await onText(passes)).toMatchObject({ status: "pass" });
    expect(await onText(fails)).toMatchObject({ status: "fail", detail: lacks(time, what, sentence) });
  });

  it.each([
    "before 12:00 PM ET",
    "after 12:00 PM ET",
    "from 12:00 PM ET",
    "until 12:00 PM ET",
    "till 12:00 PM ET",
    "by 12:00 PM ET",
    "starting at 12:00 PM ET",
    "up to 12:00 PM ET",
    "at 12:00 PM ET or later",
    "at 12:00 PM ET or earlier",
    "at 12:00 PM Eastern Time or later",
    "before\t12:00 PM ET",
  ])("the bound %j needs no weekday", async (bound) => {
    expect(await onText(`Dr. Haddad has openings ${bound} that week.`)).toMatchObject({ status: "pass" });
  });

  it("a range end after a bound word is a bound too, and its start takes its ET", async () => {
    expect(await onText("Dr. Haddad is in that week from 8:00 AM until 5:00 PM ET.")).toMatchObject({
      status: "pass",
    });
  });

  it('a range end after "to" isn\'t a bound, so it needs a weekday', async () => {
    expect(await onText("Dr. Haddad is in that week from 8:00 AM to 5:00 PM ET.")).toMatchObject({
      status: "fail",
      detail: lacks("5:00 PM", WEEKDAY, "Dr. Haddad is in that week from 8:00 AM to 5:00 PM ET."),
    });
  });

  it.each([
    "8:00 AM - 5:00 PM Eastern Time",
    "8:00 AM – 5:00 PM Eastern Time",
    "8:00 AM till 5:00 PM Eastern Time",
  ])("the range %j gives its start its end's ET", async (range) => {
    expect(await onText(`Monday, ${range}.`)).toMatchObject({ status: "pass" });
  });

  it("a plain AM's period ends the sentence, and isn't part of the time", async () => {
    expect(await onText("Openings start at 8:00 AM. Monday is the first day.")).toMatchObject({
      status: "fail",
      detail: lacks("8:00 AM", "ET", "Openings start at 8:00 AM."),
    });
  });

  it.each(["Dr. Haddad has 10:00 AM ET open that daytime.", "Dr. Haddad has 10:00 AM ET open somethat day."])(
    '"that day" counts only as whole words: %j fails',
    async (text) => {
      expect(await onText(text)).toMatchObject({ status: "fail", detail: lacks("10:00 AM", WEEKDAY, text) });
    },
  );

  it.each([
    [
      'the period of a word that ends in "Dr" ends a sentence',
      "Monday is with CDr. 10:00 AM ET is open.",
      "10:00 AM ET is open.",
    ],
    [
      'a period after an earlier "Dr" ends a sentence',
      "Dr. Haddad is out Monday. 10:00 AM ET is open.",
      "10:00 AM ET is open.",
    ],
    [
      'a newline after "Dr" ends a sentence',
      "Monday, see your Dr\n10:00 AM ET is open",
      "10:00 AM ET is open",
    ],
    [
      "a sentence ends at its mark, with nothing after it",
      "10:00 AM ET is open.Monday is full.",
      "10:00 AM ET is open.",
    ],
    [
      "a word that ends in a bound word is no bound",
      "Openings nearby 12:00 PM ET that week.",
      "Openings nearby 12:00 PM ET that week.",
    ],
  ])("%s", async (_what, text, sentence) => {
    const time = /\d+:\d\d [AP]M/.exec(sentence)?.[0] ?? "";
    expect(await onText(text)).toMatchObject({ status: "fail", detail: lacks(time, WEEKDAY, sentence) });
  });

  it("a bound word that opens the text makes a bound", async () => {
    expect(await onText("Before 12:00 PM ET works that week.")).toMatchObject({ status: "pass" });
  });

  it("a range start takes the ET of the time right after it, not a later one", async () => {
    expect(
      await onText("We're open Monday to Friday, 8:00 AM to 5:00 PM Eastern Time, not 6:00 PM ET."),
    ).toMatchObject({ status: "pass" });
  });

  it("a range start whose end has no ET lacks ET", async () => {
    expect(await onText("Monday, 8:00 AM to 5:00 PM.")).toMatchObject({
      status: "fail",
      detail: lacks("8:00 AM", "ET", "Monday, 8:00 AM to 5:00 PM."),
    });
  });

  it("an empty text, and a text with no clock time, pass", async () => {
    expect(await timesCheck([ASKS, assistant("")])).toMatchObject({ status: "pass" });
    expect(await onText("Let me check that week for you.")).toMatchObject({ status: "pass" });
  });
});

describe("the new reading leaves pairs and day-line times to their own rule (r1/A-1, A-2)", () => {
  it("claims a pair's own time when a period ends the pair and a time follows it at once", () => {
    expect(unclaimedTimes("Monday, October 19 at 10:00 a.m.10:30 AM ET").map((t) => t.raw)).toEqual([
      "10:30 AM",
    ]);
  });

  it("claims neither a pair's own time nor a listed time under a day line", () => {
    const text = "Tuesday, October 13 at 1:00 PM ET and 1:30 PM.\nWednesday, October 14:\n- 2:00 PM\n3:00 PM";
    expect(unclaimedTimes(text).map((t) => t.raw)).toEqual(["1:30 PM", "3:00 PM"]);
  });

  it("a pair without ET fails on its own window", async () => {
    expect(await onText("Monday, October 19 at 10:00 AM works for us")).toMatchObject({
      status: "fail",
      detail: '"October 19 at 10:00 AM" lacks a weekday or ET',
    });
  });

  it("a pair's window doesn't stop at the next clock time: only a newly graded time's does (0cdd23a/SPEC-1 (a))", async () => {
    expect(await onText("Monday, October 19 at 9:30 AM, 10:00 AM ET.")).toMatchObject({ status: "pass" });
  });

  it("reports a failing pair before a failing new time, though the new time comes first", async () => {
    expect(await onText("Let me check 2:00 PM.\nOctober 13 at 1:00 PM ET")).toMatchObject({
      status: "fail",
      detail: '"October 13 at 1:00 PM" lacks a weekday or ET',
    });
  });

  it("reports a failing day-line time before a failing new time", async () => {
    expect(await onText("Let me check 2:00 PM.\nTuesday, October 13:\n- 1:00 PM")).toMatchObject({
      status: "fail",
      detail: '"October 13 … 1:00 PM" lacks a weekday or ET',
    });
  });
});

describe("the prompt's bound sentence (#328)", () => {
  const stable = buildSystemPrompt({ now: new Date("2026-10-19T14:00:00Z") }).stable;
  const START = "A time right after ";
  const END = ", needs only ET";
  const SPLIT = ", or followed by ";

  /** The double-quoted strings in `text`, as written. */
  const quoted = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
  /** The bound words and "ET or <tail>" forms the current prompt quotes, or a failure naming the missing anchor. */
  const promptBounds = (prompt: string): { words: string[]; tails: string[] } => {
    for (const anchor of [START, END, SPLIT]) {
      expect(prompt.split(anchor).length, `the anchor ${JSON.stringify(anchor)} occurs exactly once`).toBe(2);
    }
    const [, afterStart = ""] = prompt.split(START);
    const [span = ""] = afterStart.split(END);
    const [wordPart = "", afterPart = ""] = span.split(SPLIT);
    const words = quoted(wordPart).map((w) => w.toLowerCase());
    const forms = quoted(afterPart);
    expect(words.length, "the bound words before the split").toBeGreaterThan(0);
    expect(forms.length, "the forms after the split").toBeGreaterThan(0);
    for (const f of forms) expect(f.startsWith("ET or "), `the form "${f}" starts with "ET or "`).toBe(true);
    return { words, tails: forms.map((f) => f.slice("ET or ".length).toLowerCase()) };
  };
  const graderWords: string[] = BOUND_WORDS.map((w) => w.toLowerCase());
  const graderTails: string[] = BOUND_AFTER_TAILS.map((t) => t.toLowerCase());
  const only = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));

  it("quotes every word BOUND_BEFORE accepts", () => {
    expect(only(graderWords, promptBounds(stable).words), "grader words the prompt does not quote").toEqual(
      [],
    );
  });

  it("quotes no word BOUND_BEFORE lacks", () => {
    expect(only(promptBounds(stable).words, graderWords), "prompt words the grader lacks").toEqual([]);
  });

  it("quotes the same 'ET or <tail>' forms BOUND_AFTER accepts", () => {
    const { tails } = promptBounds(stable);
    expect(
      { missingFromPrompt: only(graderTails, tails), missingFromGrader: only(tails, graderTails) },
      "tails on one side only",
    ).toEqual({ missingFromPrompt: [], missingFromGrader: [] });
  });

  it("rejects a sentence whose anchor is gone, or whose quotes are missing", () => {
    expect(() => promptBounds(stable.replace(START, "A time next to "))).toThrow(
      /anchor "A time right after "/,
    );
    expect(() => promptBounds(stable.replace(SPLIT, `${SPLIT}${SPLIT}`))).toThrow(
      /anchor ", or followed by "/,
    );
    expect(() =>
      promptBounds(stable.replace('followed by "ET or later" or "ET or earlier"', "followed by ET or later")),
    ).toThrow(/forms after the split/);
    expect(() =>
      promptBounds(stable.replace('followed by "ET or later"', 'followed by "ET and later"')),
    ).toThrow(/starts with "ET or "/);
  });

  it("rejects an unquoted word list, a missing END anchor and a doubled START anchor", () => {
    const quotedWords = '"before", "after", "from", "until", "till", "by", "starting at" or "up to"';
    expect(stable).toContain(quotedWords);
    expect(() => promptBounds(stable.replace(quotedWords, "any of the usual words"))).toThrow(
      /bound words before the split/,
    );
    expect(() => promptBounds(stable.replace(END, ", needs ET only"))).toThrow(/anchor ", needs only ET"/);
    expect(() => promptBounds(stable.replace(START, `${START}${START}`))).toThrow(
      /anchor "A time right after "/,
    );
  });
});

/** Monday to Friday, October 19 to 23, as day lines each listing `time`; `override` gives a day its own line. */
const WEEK_DAYS: [string, string][] = [
  ["Monday", "October 19"],
  ["Tuesday", "October 20"],
  ["Wednesday", "October 21"],
  ["Thursday", "October 22"],
  ["Friday", "October 23"],
];
const dayLines = (days: readonly [string, string][] = WEEK_DAYS, override: Record<string, string> = {}) =>
  days.map(([day, date]) => `${day}, ${date}:\n- ${override[day] ?? "10:00 AM ET"}`).join("\n\n");

describe("#326's and #332's sentences, placed as they were in their trials (#337, A-3)", () => {
  const preTool = (sentence: string) => timesCheck([ASKS, assistant(sentence), HADDAD_10AM]);
  const PRE = "Let me check Dr. Haddad's";

  it.each([
    `${PRE} availability at 10:00 AM ET that week.`,
    `${PRE} availability at 10:00 AM ET each day that week.`,
  ])("a pre-tool line with ET needs no weekday (r1/Q-1 (b)): %j", async (line) => {
    expect(await preTool(line)).toMatchObject({ status: "pass" });
  });

  it.each([
    `${PRE} openings at 10:00 AM each day that week.`,
    `${PRE} availability at 10:00 AM for each day that week.`,
    `${PRE} availability at 10:00 AM each day that week.`,
  ])("a pre-tool line without ET fails on ET (A-1): %j", async (line) => {
    expect(await preTool(line)).toMatchObject({ status: "fail", detail: lacks("10:00 AM", "ET", line) });
  });

  it("the same ET line as the turn's last text, with no tool call after it, fails on a weekday", async () => {
    const line = `${PRE} availability at 10:00 AM ET each day that week.`;
    expect(await timesCheck([ASKS, HADDAD_10AM, assistant(line)])).toMatchObject({
      status: "fail",
      detail: lacks("10:00 AM", WEEKDAY, line),
    });
  });

  it("a pre-tool line is read by position: a tool call after a patient message, or in a later turn, isn't directly after it", async () => {
    const line = `${PRE} availability at 10:00 AM ET each day that week.`;
    const failed = { status: "fail", detail: lacks("10:00 AM", WEEKDAY, line) };
    expect(await timesCheck([ASKS, assistant(line), patient("Thanks."), HADDAD_10AM])).toMatchObject(failed);
    expect(await timesCheck([ASKS, assistant(line), ...inTurn(2, HADDAD_10AM)])).toMatchObject(failed);
  });

  it("a pair without a weekday in a pre-tool line fails on the pair, not on ET alone", async () => {
    expect(await preTool("Let me check October 19 at 10:00 AM ET.")).toMatchObject({
      status: "fail",
      detail: '"October 19 at 10:00 AM" lacks a weekday or ET',
    });
  });

  it("any tool, an errored call and several calls count as a tool call after the text", async () => {
    const line = `${PRE} availability at 10:00 AM ET each day that week.`;
    const escalate = call("escalate_to_human", {});
    const errored = call("check_availability", {}, { ok: false });
    for (const after of [[escalate], [errored], [HADDAD_10AM, escalate]])
      expect(await timesCheck([ASKS, assistant(line), ...after])).toMatchObject({ status: "pass" });
  });

  it("a text with a day line keeps the full rule, even before a tool call (the line lacks the time: #360)", async () => {
    const text = `Dr. Haddad has 10:00 AM ET open that week.\n\n${dayLines([["Monday", "October 19"]], { Monday: "11:00 AM ET" })}`;
    expect(await timesCheck([ASKS, assistant(text), HADDAD_10AM])).toMatchObject({
      status: "fail",
      detail: lacks("10:00 AM", WEEKDAY, "Dr. Haddad has 10:00 AM ET open that week."),
    });
  });

  const backed: [run: string, text: string][] = [
    [
      "#326 run 1, trial 1",
      `Great news, Walter \u2014 Dr. Haddad has 10:00 AM ET open every day that week. Here are your options:\n\n${dayLines()}\n\nWhich day works best for you?`,
    ],
    [
      "#326 run 1, trial 3",
      `Dr. Haddad has 10:00 AM ET open all five days that week:\n\n${dayLines()}\n\nWhich day works best for you?`,
    ],
    [
      "#332 run 1, trial 2",
      `Dr. Haddad has 10:00 AM ET open all five days that week. Here are your options:\n\n${dayLines()}\n\nWhich day would you prefer?`,
    ],
    [
      "#332 run 2, trial 3",
      `Dr. Haddad has 10:00 AM ET open every day that week. Here are the options:\n\n${dayLines()}\n\nWhich day works best for you?`,
    ],
  ];
  it.each(backed)(
    "%s: a several-day lead-in with five matching day lines passes (r1/Q-2 (c))",
    async (_run, text) => {
      expect(await timesCheck([ASKS, HADDAD_10AM, assistant(text)])).toMatchObject({ status: "pass" });
    },
  );

  it.each([
    ["every day that week", "Every Day That Week"],
    ["each day that week", "for each day that week"],
    ["all five days that week", "ALL FIVE DAYS THAT WEEK"],
  ])("%s counts in any case and after another word: %j", async (_phrase, phrase) => {
    const text = `Dr. Haddad has 10:00 AM ET open ${phrase}:\n\n${dayLines()}`;
    expect(await onText(text)).toMatchObject({ status: "pass" });
  });

  it.each(["every day", "other days that week", "those days", "every weekday", "all days that week"])(
    'the phrase "%s" is no several-day phrase, even with five day lines',
    async (phrase) => {
      const sentence = `Dr. Haddad has 10:00 AM ET open ${phrase}:`;
      expect(await onText(`${sentence}\n\n${dayLines()}`)).toMatchObject({
        status: "fail",
        detail: lacks("10:00 AM", WEEKDAY, sentence),
      });
    },
  );

  const LEAD = "Dr. Haddad has 10:00 AM ET open every day that week.";
  const offerCheck = (text: string) =>
    timesCheck([ASKS, HADDAD_10AM, assistant(text)]).then((r) => [r?.status, r?.detail]);
  const FAILS_ON_WEEKDAY = ["fail", lacks("10:00 AM", WEEKDAY, LEAD)];

  it("the same lead-in with only Monday, Tuesday and Wednesday day lines fails on a weekday", async () => {
    expect(await offerCheck(`${LEAD}\n\n${dayLines(WEEK_DAYS.slice(0, 3))}`)).toEqual(FAILS_ON_WEEKDAY);
  });

  it.each(WEEK_DAYS.map(([day]) => day))("a missing %s line fails the lead-in", async (missing) => {
    const days = WEEK_DAYS.filter(([day]) => day !== missing);
    expect(await offerCheck(`${LEAD}\n\n${dayLines(days)}`)).toEqual(FAILS_ON_WEEKDAY);
  });

  it.each(WEEK_DAYS.map(([day]) => day))(
    "a %s line listing 11:00 AM ET instead fails the lead-in",
    async (day) => {
      expect(await offerCheck(`${LEAD}\n\n${dayLines(WEEK_DAYS, { [day]: "11:00 AM ET" })}`)).toEqual(
        FAILS_ON_WEEKDAY,
      );
    },
  );

  it("a day line that lists the time among others backs it, and so does a sixth (Saturday) line", async () => {
    const withMore = dayLines(WEEK_DAYS, { Tuesday: "10:00 AM ET\n- 9:00 AM ET" });
    expect(await offerCheck(`${LEAD}\n\n${withMore}\n\nSaturday, October 24:\n- 11:00 AM ET`)).toEqual([
      "pass",
      undefined,
    ]);
  });

  it("a Thursday date heading with no listed time beside its day line leaves the lead-in backed (#337's reading, unchanged by #340)", async () => {
    const text = `${LEAD}

${dayLines()}

Thursday, October 29: none`;
    expect(await offerCheck(text)).toEqual(["pass", undefined]);
  });

  it("a second line for a day that lacks the time fails the lead-in", async () => {
    const text = `${LEAD}\n\n${dayLines()}\n\nThursday, October 29:\n- 11:00 AM ET`;
    expect(await offerCheck(text)).toEqual(FAILS_ON_WEEKDAY);
  });

  it.each([
    "Dr. Haddad has 10:00 AM ET open levery day that week.",
    "Dr. Haddad has 10:00 AM ET open every day that weekend.",
  ])("the phrase counts as whole words only: %j fails even with five day lines", async (sentence) => {
    expect(await onText(`${sentence}\n\n${dayLines()}`)).toMatchObject({
      status: "fail",
      detail: lacks("10:00 AM", WEEKDAY, sentence),
    });
  });

  it("a Thursday heading with no listed time fails the lead-in", async () => {
    const text = `${LEAD}\n\n${dayLines(WEEK_DAYS.slice(0, 3))}\n\nThursday, October 22: none\n\n${dayLines(WEEK_DAYS.slice(4))}`;
    expect(await offerCheck(text)).toEqual(FAILS_ON_WEEKDAY);
  });

  it("day lines in a later text don't back a lead-in in an earlier one", async () => {
    const events = [
      ASKS,
      HADDAD_10AM,
      assistant(LEAD),
      patient("Go on."),
      HADDAD_10AM,
      assistant(dayLines()),
    ];
    expect(await timesCheck(events)).toMatchObject({
      status: "fail",
      detail: lacks("10:00 AM", WEEKDAY, LEAD),
    });
  });

  it("the time's own sentence must hold the phrase", async () => {
    const text = `Dr. Haddad has 10:00 AM ET open.\nIt is the same every day that week.\n\n${dayLines()}`;
    expect(await offerCheck(text)).toEqual([
      "fail",
      lacks("10:00 AM", WEEKDAY, "Dr. Haddad has 10:00 AM ET open."),
    ]);
  });

  it('#326 run 2: the "Other days that week" remark fails on a weekday after a one-day offer, until #360 (r1/Q-3 (a)): the one day line names the day', async () => {
    const remark = "Other days that week may have 10:00 AM ET available too if you'd prefer a different day.";
    const text = `Dr. Haddad has 10:00 AM ET open that day:\n\nMonday, October 19, 2026:\n- 10:00 AM ET\n\n${remark} Would Monday at 10:00 AM ET work, or would you like me to check later in the week?`;
    expect(await offerCheck(text)).toEqual(["pass", undefined]);
    const second = `${text}\n\nFriday, October 23:`;
    expect(await offerCheck(second)).toEqual(["fail", lacks("10:00 AM", WEEKDAY, remark)]);
  });

  it("#332 run 2: the 12:00 PM aside fails on ET, and 1:00 PM in its sentence is a bound that passes", async () => {
    const aside =
      "Just to note, 12:00 PM does count as afternoon at Cedar Ridge, but here are slots starting at 1:00 PM ET and later:";
    const text = `${aside}\n\nTuesday, October 13:\n- 1:00 PM ET with Dr. Priya Lee\n- 1:00 PM ET with Dr. Samuel Okafor\n\nThursday, October 15:\n- 1:00 PM ET with Dr. Priya Lee\n- 1:00 PM ET with Dr. Samuel Okafor\n\nMore times are available on both days if you'd like to see others. Which works for you?`;
    expect(await offerCheck(text)).toEqual(["fail", lacks("12:00 PM", "ET", aside)]);
    const bound = unclaimedTimes(text).find((u) => u.raw === "1:00 PM");
    expect(bound?.sentence).toBe(aside);
    expect(bound && unclaimedTimeLacks(text, bound, false)).toBeUndefined();
  });

  it('#332 run 2: "openings at 2:00 PM ET and later" is a bound (r1/Q-3 (b))', async () => {
    const text =
      "Good news, there are openings at 2:00 PM ET and later. Here's a sample across the week:\n\nMonday, October 12:\n- 2:00 PM ET with Dr. Priya Lee\n- 2:00 PM ET with Dr. Samuel Okafor\n\nThursday, October 15:\n- 2:00 PM ET with Dr. Priya Lee\n- 2:00 PM ET with Dr. Samuel Okafor\n- 3:00 PM ET with Dr. Priya Lee\n\nMore times are available on these and other days if you'd like to see others.\n\nDo any of these work, or would you prefer a different day or provider?";
    expect(await offerCheck(text)).toEqual(["pass", undefined]);
  });

  it.each([
    "openings at 2:00 PM ET and later",
    "openings at 2:00 PM ET and earlier",
    "openings at 2:00 PM Eastern Time and earlier",
    "openings at 2:00 PM ET AND LATER",
  ])('"and later" and "and earlier" make a bound too: %j', async (bound) => {
    expect(await onText(`Good news, there are ${bound}.`)).toMatchObject({ status: "pass" });
  });

  it.each(["openings at 2:00 PM ET onward", "openings past 2:00 PM ET", "openings at 2:00 PM ET or after"])(
    "%j isn't a bound",
    async (words) => {
      const sentence = `Good news, there are ${words}.`;
      expect(await onText(sentence)).toMatchObject({
        status: "fail",
        detail: lacks("2:00 PM", WEEKDAY, sentence),
      });
    },
  );

  it('a bound with "and" still needs ET', async () => {
    const sentence = "Good news, there are openings at 2:00 PM and later.";
    expect(await onText(sentence)).toMatchObject({
      status: "fail",
      detail: lacks("2:00 PM", "ET", sentence),
    });
  });
});

describe('#340: "next week", "both days" and "each of those days" name the days when day lines back them', () => {
  const WED_THU_FRI: [string, string][] = [
    ["Wednesday", "October 14"],
    ["Thursday", "October 15"],
    ["Friday", "October 16"],
  ];
  const TWO = WED_THU_FRI.slice(0, 2);
  const textCheck = (text: string) => onText(text).then((r) => [r?.status, r?.detail]);
  const PASSES = ["pass", undefined];
  const failsOn = (sentence: string) => ["fail", lacks("10:00 AM", WEEKDAY, sentence)];
  /** Two backing day lines and a third date heading with no listed time fail the phrase (SPEC-2 (b)). */
  const expectTimelessHeadingFails = async (sentence: string) => {
    const text = `${sentence}\n\n${dayLines(TWO)}\n\nFriday, October 16: none`;
    expect(await textCheck(text)).toEqual(failsOn(sentence));
  };
  /** A glued phrase fails even with two backing day lines. */
  const expectGluedFails = async (words: string) => {
    const glued = `Dr. Haddad has 10:00 AM ET open ${words}:`;
    expect(await textCheck(`${glued}\n\n${dayLines(TWO)}`)).toEqual(failsOn(glued));
  };

  describe("the sentences of #339's gate runs, whole texts placed as they were in their trials (A-2)", () => {
    const RESCHEDULE_TEXT =
      "Here are the times around 2:00 and 3:00 PM ET on both days:\n\nWednesday, October 14:\n- 2:00 PM ET\n- 3:00 PM ET\n\nThursday, October 15:\n- 2:00 PM ET\n- 3:00 PM ET\n\nMore times are available on these days if you'd like to see others. Which works for you?";
    const PT_TEXT =
      "Dr. Anna Kowalski has 8:00 AM ET open every day next week. Here are the options:\n\nMonday, November 2:\n- 8:00 AM ET\n\nTuesday, November 3:\n- 8:00 AM ET\n\nWednesday, November 4:\n- 8:00 AM ET\n\nThursday, November 5:\n- 8:00 AM ET\n\nFriday, November 6:\n- 8:00 AM ET\n\nMore times are available on these days if you'd like to see others. Which day works best for you, James, and what's the reason for the visit?";
    /** What the trials' searches returned: Dr. Lee at 2:00 and 3:00 PM EDT, Dr. Kowalski at 8:00 AM EST. */
    const RESCHEDULE_SLOTS = [14, 15].flatMap((d) => [18, 19].map((h) => `lee@2026-10-${d}T${h}:00:00Z`));
    const PT_SLOTS = [2, 3, 4, 5, 6].map((d) => `kowalski@2026-11-0${d}T13:00:00Z`);
    const RESCHEDULE_SENTENCE = "Here are the times around 2:00 and 3:00 PM ET on both days:";
    const PT_SENTENCE = "Dr. Anna Kowalski has 8:00 AM ET open every day next week.";

    it("reschedule-single-appointment, run 39184388331: both day lines list 3:00 PM, so it passes (2:00 has no AM/PM)", async () => {
      const events = [
        patient("Do you have anything later, like 2 or 3 PM on either day?"),
        checked(...RESCHEDULE_SLOTS),
        assistant(RESCHEDULE_TEXT),
      ];
      expect(await timesCheck(events)).toMatchObject({ status: "pass" });
    });

    it("book-pt-after-dst-est, run 39186778496: five day lines list 8:00 AM, so it passes", async () => {
      const events = [
        patient("I'd like a physical therapy appointment in the first week of November, at 8 AM."),
        checked(...PT_SLOTS),
        assistant(PT_TEXT),
      ];
      expect(await timesCheck(events)).toMatchObject({ status: "pass" });
    });

    it("the reschedule text with a third date fails, and so does one day line without 3:00 PM", async () => {
      const third = `${RESCHEDULE_TEXT}\n\nFriday, October 16:\n- 2:00 PM ET\n- 3:00 PM ET`;
      expect(await textCheck(third)).toEqual(["fail", lacks("3:00 PM", WEEKDAY, RESCHEDULE_SENTENCE)]);
      const missing = RESCHEDULE_TEXT.replace(
        "Thursday, October 15:\n- 2:00 PM ET\n- 3:00 PM ET",
        "Thursday, October 15:\n- 2:00 PM ET",
      );
      expect(await textCheck(missing)).toEqual(["fail", lacks("3:00 PM", WEEKDAY, RESCHEDULE_SENTENCE)]);
    });

    it("the PT text with Friday's line dropped fails", async () => {
      const dropped = PT_TEXT.replace("Friday, November 6:\n- 8:00 AM ET\n\n", "");
      expect(await textCheck(dropped)).toEqual(["fail", lacks("8:00 AM", WEEKDAY, PT_SENTENCE)]);
    });
  });

  describe('"every day", "each day" and "all five days", then "next week"', () => {
    it.each([
      "every day next week",
      "each day next week",
      "all five days next week",
      "Every Day Next Week",
      "for each day next week",
    ])("%j with five matching day lines passes", async (phrase) => {
      expect(await textCheck(`Dr. Haddad has 10:00 AM ET open ${phrase}:\n\n${dayLines()}`)).toEqual(PASSES);
    });

    it.each(["every day next week", "each day next week", "all five days next week"])(
      "%j with only Monday to Thursday day lines fails",
      async (phrase) => {
        const sentence = `Dr. Haddad has 10:00 AM ET open ${phrase}:`;
        expect(await textCheck(`${sentence}\n\n${dayLines(WEEK_DAYS.slice(0, 4))}`)).toEqual(
          failsOn(sentence),
        );
      },
    );

    it('"every day next week" with a second Thursday heading of the same text that lacks the time fails (SPEC-1)', async () => {
      const sentence = "Dr. Haddad has 10:00 AM ET open every day next week:";
      const second = (time: string) => `${dayLines()}\n\nThursday, October 22:\n- ${time}`;
      expect(await textCheck(`${sentence}\n\n${second("10:00 AM ET")}`)).toEqual(PASSES);
      expect(await textCheck(`${sentence}\n\n${second("11:00 AM ET")}`)).toEqual(failsOn(sentence));
    });

    it('"every day next week" with one day line listing 11:00 AM ET instead fails', async () => {
      const sentence = "Dr. Haddad has 10:00 AM ET open every day next week:";
      const text = `${sentence}\n\n${dayLines(WEEK_DAYS, { Wednesday: "11:00 AM ET" })}`;
      expect(await textCheck(text)).toEqual(failsOn(sentence));
    });

    it.each([
      "every day this week",
      "each day this week",
      "all five days this week",
      "every day next weekend",
      "every weekday next week",
      "all days next week",
    ])("%j is no several-day phrase, even with five day lines", async (phrase) => {
      const sentence = `Dr. Haddad has 10:00 AM ET open ${phrase}:`;
      expect(await textCheck(`${sentence}\n\n${dayLines()}`)).toEqual(failsOn(sentence));
    });
  });

  describe('"both days": exactly two dates, each listing the time', () => {
    const SENTENCE = "Dr. Haddad has 10:00 AM ET open on both days:";

    it("two day lines that list the time pass, in any case", async () => {
      expect(await textCheck(`${SENTENCE}\n\n${dayLines(TWO)}`)).toEqual(PASSES);
      expect(await textCheck(`Dr. Haddad has 10:00 AM ET open ON BOTH DAYS:\n\n${dayLines(TWO)}`)).toEqual(
        PASSES,
      );
    });

    it("two dates on the same weekday back it, because each day line carries its date", async () => {
      const lines = dayLines([
        ["Wednesday", "October 14"],
        ["Wednesday", "October 21"],
      ]);
      expect(await textCheck(`${SENTENCE}\n\n${lines}`)).toEqual(PASSES);
    });

    it("a third date fails", async () => {
      expect(await textCheck(`${SENTENCE}\n\n${dayLines(WED_THU_FRI)}`)).toEqual(failsOn(SENTENCE));
    });

    it("one date passes since #360 (r1/Q-3 (a): its day line names the day), and no day line fails", async () => {
      expect(await textCheck(`${SENTENCE}\n\n${dayLines(TWO.slice(0, 1))}`)).toEqual(PASSES);
      expect(await textCheck(SENTENCE)).toEqual(failsOn(SENTENCE));
    });

    it("a day line that lacks the time fails", async () => {
      const text = `${SENTENCE}\n\n${dayLines(TWO, { Thursday: "11:00 AM ET" })}`;
      expect(await textCheck(text)).toEqual(failsOn(SENTENCE));
    });

    it("two headings for one date count once, and both must list the time", async () => {
      const again = (time: string) => `Wednesday, October 14, 2026:\n- ${time}`;
      const oneDateTwice = `${dayLines(TWO.slice(0, 1))}\n\n${again("10:00 AM ET")}`;
      expect(await textCheck(`${SENTENCE}\n\n${oneDateTwice}`)).toEqual(PASSES);
      const oneLacks = `${dayLines(TWO.slice(0, 1))}\n\n${again("11:00 AM ET")}`;
      expect(await textCheck(`${SENTENCE}\n\n${oneLacks}`)).toEqual(failsOn(SENTENCE));
      const bothListed = `${dayLines(TWO)}\n\n${again("10:00 AM ET")}`;
      expect(await textCheck(`${SENTENCE}\n\n${bothListed}`)).toEqual(PASSES);
      const secondLacks = `${dayLines(TWO)}\n\n${again("11:00 AM ET")}`;
      expect(await textCheck(`${SENTENCE}\n\n${secondLacks}`)).toEqual(failsOn(SENTENCE));
    });

    it("a closing line that names a third date fails, though it is prose (review decision ea50048/VER-1 (a))", async () => {
      const closing = "Your current appointment on Friday, October 16 at 9:00 AM ET stays until you choose.";
      expect(await textCheck(`${SENTENCE}\n\n${dayLines(TWO)}\n\n${closing}`)).toEqual(failsOn(SENTENCE));
    });

    it("a prose line that names one of the two dates without the time fails too (VER-1 (a), mixed case)", async () => {
      const prose = "Wednesday, October 14 is also when your current appointment is.";
      expect(await textCheck(`${SENTENCE}\n\n${dayLines(TWO)}\n\n${prose}`)).toEqual(failsOn(SENTENCE));
    });

    it("a third date heading with no listed time fails (review decision dcdf3ec/SPEC-2 (b))", () =>
      expectTimelessHeadingFails(SENTENCE));

    it("two headings with the same text for one date count once, and each must list the time (SPEC-1)", async () => {
      const heading = (time: string) => `Wednesday, October 14:\n- ${time}`;
      const thursday = dayLines(TWO.slice(1));
      const both = `${heading("10:00 AM ET")}\n\n${heading("10:00 AM ET")}\n\n${thursday}`;
      expect(await textCheck(`${SENTENCE}\n\n${both}`)).toEqual(PASSES);
      const second = `${heading("10:00 AM ET")}\n\n${heading("11:00 AM ET")}\n\n${thursday}`;
      expect(await textCheck(`${SENTENCE}\n\n${second}`)).toEqual(failsOn(SENTENCE));
    });

    it("a day line that lists the time among others backs it", async () => {
      const text = `${SENTENCE}\n\n${dayLines(TWO, { Wednesday: "10:00 AM ET\n- 11:00 AM ET" })}`;
      expect(await textCheck(text)).toEqual(PASSES);
    });

    it.each(["on lboth days", "on both dayss"])("whole words only: %j fails", expectGluedFails);

    it("day lines in a later text don't back it", async () => {
      const later = [ASKS, assistant(SENTENCE), patient("Go on."), assistant(dayLines(TWO))];
      expect(await timesCheck(later)).toMatchObject({
        status: "fail",
        detail: lacks("10:00 AM", WEEKDAY, SENTENCE),
      });
    });
  });

  describe('"each of those days": at least two dates, each listing the time', () => {
    const SENTENCE = "Dr. Haddad has 10:00 AM ET open each of those days:";

    it.each([
      ["two", TWO],
      ["three", WED_THU_FRI],
    ])("%s day lines that list the time pass", async (_n, days) => {
      expect(await textCheck(`${SENTENCE}\n\n${dayLines(days)}`)).toEqual(PASSES);
    });

    it("one date passes since #360 (r1/Q-3 (a)), and a day line without the time fails", async () => {
      expect(await textCheck(`${SENTENCE}\n\n${dayLines(TWO.slice(0, 1))}`)).toEqual(PASSES);
      const text = `${SENTENCE}\n\n${dayLines(WED_THU_FRI, { Friday: "11:00 AM ET" })}`;
      expect(await textCheck(text)).toEqual(failsOn(SENTENCE));
    });

    it.each(["on each of those dayss", "oneach of those days"])(
      "whole words only: %j fails",
      expectGluedFails,
    );

    it("title case passes", async () => {
      const sentence = "Dr. Haddad has 10:00 AM ET open Each Of Those Days:";
      expect(await textCheck(`${sentence}\n\n${dayLines(TWO)}`)).toEqual(PASSES);
    });

    it("a date heading with no listed time fails, as a day line without the time (review decision dcdf3ec/SPEC-2 (b))", () =>
      expectTimelessHeadingFails(SENTENCE));

    it('"those days" alone still needs a weekday, even with two day lines', async () => {
      const sentence = "Dr. Haddad has 10:00 AM ET open those days:";
      expect(await textCheck(`${sentence}\n\n${dayLines(TWO)}`)).toEqual(failsOn(sentence));
    });
  });
});

describe('#360: hours remarks, one-day closing questions and "between … and" ranges, with #345\'s eight failing trials whole', () => {
  const say = (turn: number, text: string): TranscriptEvent => ({ ...assistant(text), turn });
  const tool = (turn: number, name: string): TranscriptEvent => ({ ...call(name, {}), turn });
  /** Every sentence of `text` this check fails (`unclaimedTimes`), not only the first the verdict names. */
  const failingSentences = (text: string, preTool = false): string[] => {
    const etOnly = preTool && headingListTimes(text).length === 0;
    return unclaimedTimes(text).flatMap((u) => {
      const what = unclaimedTimeLacks(text, u, etOnly);
      return what === undefined ? [] : [lacks(u.raw, what, u.sentence)];
    });
  };
  const passes = async (text: string) => expect(await onText(text)).toMatchObject({ status: "pass" });
  const failsWith = async (text: string, detail: string) =>
    expect(await onText(text)).toMatchObject({ status: "fail", detail });

  /** The eight failing trials of #345's exit run (the patient's lines left out: this check reads only the assistant's). */
  const TRIALS: [scenarioId: string, trial: number, events: TranscriptEvent[]][] = [
    [
      "availability-weekend-after-hours",
      1,
      [
        say(
          1,
          "Unfortunately, Cedar Ridge Health is only open Monday through Friday, 8:00 AM to 5:00 PM ET. There are no weekend or evening appointments available.\n\nIf you can find a window during those hours, I'm happy to look for the earliest openings that fit your schedule. Would a morning or afternoon slot work better for you, James?",
        ),
        say(2, "Let me check afternoon availability in family medicine for this week and next week."),
        tool(2, "check_availability"),
        say(2, "Let me look for the later afternoon slots specifically."),
        tool(2, "check_availability"),
        say(
          2,
          "The latest slot each day is 4:30 PM ET, since the clinic closes at 5:00 PM and visits are 30 minutes. Here are the available 4:30 PM ET slots with Dr. Elena Alvarez in family medicine:\n\nThursday, October 8:\n- 4:30 PM ET\n\nFriday, October 9:\n- 4:30 PM ET\n\nMore 4:30 PM ET slots are available on later dates if these don't work. Would any of these work for you, James, or would you like to see more dates?",
        ),
        say(
          3,
          "No problem, James! Whenever you're ready to book, just reach out and I'll find the best available time for you.",
        ),
      ],
    ],
    [
      "availability-weekend-after-hours",
      2,
      [
        say(
          1,
          "Unfortunately, Cedar Ridge Health is only open Monday through Friday, 8:00 AM to 5:00 PM ET. There are no evening or weekend appointments available.\n\nThat said, I'm happy to find you the earliest available family medicine slot during those hours. Would any particular day or time of day work best for you, James?",
        ),
        say(2, "Let me check for late-afternoon family medicine openings this week and next."),
        tool(2, "check_availability"),
        say(
          2,
          "The latest possible slot is 4:30 PM ET, since visits are 30 minutes and the clinic closes at 5 PM. Here's what's available with Dr. Elena Alvarez:\n\nThursday, October 8:\n- 4:00 PM ET\n- 4:30 PM ET\n\nFriday, October 9:\n- 4:00 PM ET\n- 4:30 PM ET\n\nMonday, October 12:\n- 4:00 PM ET\n\nMore times are available on later days if you'd like to see others. What's the reason for your visit, James?",
        ),
        say(
          3,
          "Of course, take your time! When you're ready to book, just come back and I can check availability for whatever day works best for you.",
        ),
      ],
    ],
    [
      "availability-weekend-after-hours",
      3,
      [
        say(
          1,
          "Unfortunately, Cedar Ridge Health is only open Monday through Friday, 8:00 AM to 5:00 PM ET. There are no evening or weekend hours available.\n\nThat said, I'd be happy to help you find the earliest available family medicine slot during the week. Would you like me to check what's open, and is there a particular time of day that works best for you — earlier in the morning or closer to the end of the day?",
        ),
        say(2, "Let me check afternoon availability for family medicine over the next two weeks."),
        tool(2, "check_availability"),
        say(2, "Let me look for the latest times specifically, closer to end of day."),
        tool(2, "check_availability"),
        say(
          2,
          "The latest available slot on any weekday is 4:30 PM ET — since the clinic closes at 5:00 PM and visits are 30 minutes, that's as late as it goes. Dr. Elena Alvarez has 4:30 PM ET open on multiple days:\n\nThursday, October 8:\n- 4:30 PM ET\n\nFriday, October 9:\n- 4:30 PM ET\n\nMonday, October 12:\n- 4:30 PM ET\n\nTuesday, October 13:\n- 4:30 PM ET\n\nWednesday, October 14:\n- 4:30 PM ET\n\nMore times are available on later days if you'd like. Would any of these work for you, James?",
        ),
        say(
          3,
          "Of course, James! Whenever you're ready to book, just reach out and I'll find you a time that works.",
        ),
      ],
    ],
    [
      "book-multi-constraint",
      2,
      [
        say(1, "Let me look up Dr. Haddad for you."),
        tool(1, "find_providers"),
        say(1, "Let me check Dr. Haddad's openings next week."),
        tool(1, "check_availability"),
        tool(1, "check_availability"),
        tool(1, "check_availability"),
        tool(1, "check_availability"),
        tool(1, "check_availability"),
        say(
          1,
          "Dr. Omar Haddad has plenty of openings next week. Here are some options:\n\nMonday, October 12:\n- 8:00 AM ET\n\nTuesday, October 13:\n- 8:00 AM ET\n\nWednesday, October 14:\n- 8:00 AM ET\n\nThursday, October 15:\n- 8:00 AM ET\n\nFriday, October 16:\n- 8:00 AM ET\n\nMore times are available on these days if you'd like to see others. What day and time works best for you, Walter, and what will the visit be for?",
        ),
        say(2, "Let me check Dr. Haddad's availability after 3:00 PM ET that week."),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        say(
          2,
          "No problem! Dr. Haddad has openings after 3:00 PM ET every day that week. Here's one from each day:\n\nMonday, October 19:\n- 3:00 PM ET\n\nTuesday, October 20:\n- 3:00 PM ET\n\nWednesday, October 21:\n- 3:00 PM ET\n\nThursday, October 22:\n- 3:00 PM ET\n\nFriday, October 23:\n- 3:00 PM ET\n\nMore times are available on these days (3:30, 4:00, and 4:30 PM ET each day) if you'd like. Which day works for you, and what will the visit be for?",
        ),
        say(
          3,
          "That's helpful to know. Which day would you prefer — Monday October 19, Tuesday October 20, Thursday October 22, or Friday October 23?",
        ),
        say(
          4,
          "That slot is open. Here are the details before I book it:\n\n- Provider: Dr. Omar Haddad\n- Date: Thursday, October 22, 2026 at 3:00 PM ET\n- Location: 400 Cedar Ridge Pkwy\n- Reason: blood pressure medication check\n\nShall I go ahead and book this?",
        ),
        tool(5, "book_appointment"),
        say(
          5,
          "You're all set, Walter! Your appointment with Dr. Omar Haddad is confirmed for Thursday, October 22, 2026 at 3:00 PM ET at 400 Cedar Ridge Pkwy. Is there anything else I can help you with?",
        ),
      ],
    ],
    [
      "book-provider-not-accepting",
      3,
      [
        say(1, "Let me look up Dr. Brooks for you."),
        tool(1, "find_providers"),
        say(
          1,
          "I found Dr. Marcus Brooks in family medicine. When would you like to come in, James — this week, next week, or a specific day?",
        ),
        say(2, "Let me check Dr. Brooks's afternoon openings this week."),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        say(
          2,
          "Dr. Marcus Brooks has these afternoon openings this week:\n\nMonday, October 5:\n- 12:00 PM ET\n\nTuesday, October 6:\n- 12:00 PM ET\n\nWednesday, October 7:\n- 12:00 PM ET\n\nThursday, October 8:\n- 12:00 PM ET\n\nFriday, October 9:\n- 12:00 PM ET\n\nMore times are available on these days, and into next week as well. Which day works best for you, or would you like to see other times?",
        ),
        say(3, "Let me check from 2:00 PM ET each day this week."),
        tool(3, "check_availability"),
        tool(3, "check_availability"),
        tool(3, "check_availability"),
        tool(3, "check_availability"),
        tool(3, "check_availability"),
        say(
          3,
          "Dr. Marcus Brooks has these openings after 2:00 PM ET:\n\nMonday, October 5:\n- 2:00 PM ET\n\nTuesday, October 6:\n- 2:00 PM ET\n\nWednesday, October 7:\n- 2:00 PM ET\n\nThursday, October 8:\n- 2:00 PM ET\n\nFriday, October 9:\n- 2:00 PM ET\n\nMore times are available on these days, including 3:00 PM ET and later, if you'd like to see others. Which day works for you?",
        ),
        say(
          4,
          "Just to confirm before I book: this will be an appointment with Dr. Marcus Brooks on Thursday, October 8, 2026 at 3:00 PM ET at 400 Cedar Ridge Pkwy, for a check-up. Does that all look right?",
        ),
        tool(5, "book_appointment"),
        say(
          5,
          "Unfortunately, Dr. Brooks isn't taking new patients at this time, so I'm unable to book with him. Let me find other family medicine providers who are available Thursday afternoon.",
        ),
        tool(5, "check_availability"),
        say(
          5,
          "I'm sorry about that, James. Dr. Elena Alvarez is another family medicine provider who has openings that afternoon:\n\nThursday, October 8:\n- 2:00 PM ET\n- 2:30 PM ET\n- 3:00 PM ET\n- 3:30 PM ET\n- 4:00 PM ET\n\nWould 3:00 PM ET with Dr. Alvarez work, or would you prefer a different time?",
        ),
        say(
          6,
          "To confirm: I'll book an appointment with Dr. Elena Alvarez on Thursday, October 8, 2026 at 3:00 PM ET at 400 Cedar Ridge Pkwy, for a check-up. Shall I go ahead?",
        ),
        tool(7, "book_appointment"),
        say(
          7,
          "You're all set, James! Your appointment with Dr. Elena Alvarez is confirmed for Thursday, October 8, 2026 at 3:00 PM ET at 400 Cedar Ridge Pkwy. Is there anything else I can help you with?",
        ),
      ],
    ],
    [
      "clarify-unsupported-specialty",
      3,
      [
        say(
          1,
          "Cedar Ridge Health doesn't have orthopedic surgery as a specialty. Our available specialties are family medicine, pediatrics, dermatology, cardiology, and physical therapy.\n\nIf you'd like, I can help you book with one of those — for example, family medicine or physical therapy may be options worth considering for back pain. Would any of those work for you?",
        ),
        say(2, "Let me check afternoon availability for both specialties across this week."),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        tool(2, "check_availability"),
        say(
          2,
          "There's good availability across both. Here are some options this week:\n\nMonday, October 5:\n- 12:00 PM ET with Dr. Elena Alvarez (family medicine)\n- 12:00 PM ET with Dr. Anna Kowalski (physical therapy)\n\nTuesday, October 6:\n- 12:00 PM ET with Dr. Elena Alvarez (family medicine)\n- 12:00 PM ET with Dr. Anna Kowalski (physical therapy)\n\nWednesday, October 7:\n- 12:00 PM ET with Dr. Elena Alvarez (family medicine)\n\nMore times are available on these days and throughout next week as well. Would any of these work, or would you like to see other days or times?",
        ),
        say(
          3,
          "Good news — those times are already in the results I pulled. Here are openings at 1:00 PM ET or later this week:\n\nMonday, October 5:\n- 1:00 PM ET with Dr. Elena Alvarez (family medicine)\n- 1:00 PM ET with Dr. Anna Kowalski (physical therapy)\n\nTuesday, October 6:\n- 1:00 PM ET with Dr. Elena Alvarez (family medicine)\n- 1:00 PM ET with Dr. Anna Kowalski (physical therapy)\n\nWednesday, October 7:\n- 1:00 PM ET with Dr. Elena Alvarez (family medicine)\n\nLater afternoon times (including 2:00 PM ET) are also available on these days, and there are openings next week too. Does any of these work, or would you like to see other options?",
        ),
        say(4, "That slot is available. What's the reason for your visit?"),
        say(
          5,
          "Just to confirm before I book: this will be an appointment with Dr. Elena Alvarez (family medicine) on Wednesday, October 7 at 2:00 PM ET at 400 Cedar Ridge Pkwy, for lower back pain. Shall I go ahead?",
        ),
        tool(6, "book_appointment"),
        say(
          6,
          "You're all set, James! Your appointment with Dr. Elena Alvarez is confirmed for Wednesday, October 7, 2026 at 2:00 PM ET at 400 Cedar Ridge Pkwy, for lower back pain. Is there anything else I can help you with?",
        ),
      ],
    ],
    [
      "escalate-frustration",
      1,
      [
        say(
          1,
          "The clinic is open Monday through Friday only, so Saturday appointments aren't available. I'd be happy to find you a weekday opening with Dr. Haddad instead — do you have a preferred day or week in mind?",
        ),
        say(
          2,
          "I completely understand that Saturdays are most convenient for you, Walter. Unfortunately, the clinic is closed on weekends — there are no Saturday slots available for any provider. The only option would be a weekday appointment, Monday through Friday, between 8:00 AM and 5:00 PM ET.\n\nWould a weekday work for you, perhaps a day earlier in the week or later in the afternoon?",
        ),
        tool(3, "escalate_to_human"),
        say(
          3,
          "I'm sorry for the frustration, Walter. I'll connect you with our front desk. Please call 1-800-555-0199 (Mon–Fri, 8 AM–5 PM ET). I've passed a summary of our conversation to them.",
        ),
      ],
    ],
    [
      "reschedule-declined-at-confirmation",
      3,
      [
        say(1, "Let me pull up your appointments right now."),
        tool(1, "get_my_appointments"),
        say(
          1,
          "I can see your Wednesday appointment with Dr. Anna Kowalski on October 7 at 4:00 PM ET for knee rehab. Let me check Thursday afternoon availability for physical therapy.",
        ),
        tool(1, "check_availability"),
        say(
          1,
          "Dr. Kowalski has these openings on Thursday afternoon:\n\nThursday, October 8:\n- 12:00 PM ET\n- 12:30 PM ET\n- 1:00 PM ET\n- 1:30 PM ET\n- 2:00 PM ET\n\nMore times are available that afternoon if none of these work. Which one would you like, Daniel?",
        ),
        say(
          2,
          "No problem at all! Your Wednesday, October 7 appointment with Dr. Anna Kowalski at 4:00 PM ET stays as is. Let me know if there's anything else I can help you with.",
        ),
      ],
    ],
  ];
  const trialEvents = (id: string, n: number): TranscriptEvent[] =>
    TRIALS.find(([s, t]) => s === id && t === n)?.[2] ?? [];
  const SLOT_HOURS = (tail: string) =>
    `The latest slot each day is 4:30 PM ET, since the clinic closes at 5:00 PM${tail}`;

  /** What each trial's texts get now: the verdict, and every sentence a text fails on, with the pattern it belongs to. */
  const NOW: [
    id: string,
    trial: number,
    status: "pass" | "fail",
    detail: string | undefined,
    failing: string[],
  ][] = [
    [
      "availability-weekend-after-hours",
      1,
      "fail",
      '"5:00 PM" lacks ET, in "The latest slot each day is 4:30 PM ET, since the clinic closes at 5:00 PM and visits are 30 minutes."',
      [
        '"5:00 PM" lacks ET, in "The latest slot each day is 4:30 PM ET, since the clinic closes at 5:00 PM and visits are 30 minutes."',
        '"4:30 PM" lacks a weekday or "that day", in "Here are the available 4:30 PM ET slots with Dr. Elena Alvarez in family medicine:"',
        '"4:30 PM" lacks a weekday or "that day", in "More 4:30 PM ET slots are available on later dates if these don\'t work."',
      ],
    ],
    ["availability-weekend-after-hours", 2, "pass", undefined, []],
    [
      "availability-weekend-after-hours",
      3,
      "fail",
      '"5:00 PM" lacks ET, in "The latest available slot on any weekday is 4:30 PM ET — since the clinic closes at 5:00 PM and visits are 30 minutes, that\'s as late as it goes."',
      [
        '"5:00 PM" lacks ET, in "The latest available slot on any weekday is 4:30 PM ET — since the clinic closes at 5:00 PM and visits are 30 minutes, that\'s as late as it goes."',
        '"4:30 PM" lacks a weekday or "that day", in "Dr. Elena Alvarez has 4:30 PM ET open on multiple days:"',
      ],
    ],
    [
      "book-multi-constraint",
      2,
      "fail",
      '"4:30 PM" lacks a weekday or "that day", in "More times are available on these days (3:30, 4:00, and 4:30 PM ET each day) if you\'d like."',
      [
        '"4:30 PM" lacks a weekday or "that day", in "More times are available on these days (3:30, 4:00, and 4:30 PM ET each day) if you\'d like."',
      ],
    ],
    ["book-provider-not-accepting", 3, "pass", undefined, []],
    [
      "clarify-unsupported-specialty",
      3,
      "fail",
      '"2:00 PM" lacks a weekday or "that day", in "Later afternoon times (including 2:00 PM ET) are also available on these days, and there are openings next week too."',
      [
        '"2:00 PM" lacks a weekday or "that day", in "Later afternoon times (including 2:00 PM ET) are also available on these days, and there are openings next week too."',
      ],
    ],
    ["escalate-frustration", 1, "pass", undefined, []],
    ["reschedule-declined-at-confirmation", 3, "fail", '"October 7 at 4:00 PM" lacks a weekday or ET', []],
  ];

  describe("each trial's verdict and failing sentences", () => {
    it.each(NOW)("%s, trial %i: %s", async (id, trial, status, detail, failing) => {
      const events = trialEvents(id, trial);
      expect(await graded(id, events, "times_in_clinic_tz_with_weekday")).toMatchObject({
        status,
        ...(detail === undefined ? {} : { detail }),
      });
      const failed = events.flatMap((e, i) =>
        e.kind === "assistant"
          ? failingSentences(e.text, events[i + 1]?.kind === "tool_call" && events[i + 1]?.turn === e.turn)
          : [],
      );
      expect(failed).toEqual(failing);
    });
  });

  describe("an hours remark (r1/Q-1 (a)): the last start or an opening hour needs ET, not a weekday", () => {
    it("the last start of a visit after a latest-slot phrase passes (the trial 2 sentence, and a closing hour with ET)", async () => {
      await passes(
        "The latest possible slot is 4:30 PM ET, since visits are 30 minutes and the clinic closes at 5 PM.",
      );
      await passes("The clinic closes at 5:00 PM ET.");
      await passes("Closes at 5:00 PM ET.");
      await passes("The clinic opens at 8:00 AM ET.");
    });

    it.each([
      "latest slot",
      "latest possible slot",
      "latest available slot",
      "latest appointment",
      "last slot",
      "last appointment",
      "Latest Slot",
    ])("the phrase %j passes", (phrase) => passes(`The ${phrase} is 4:30 PM ET.`));

    it("without ET it fails on ET, under every phrase", () =>
      failsWith(
        "The latest slot each day is 4:30 PM.",
        lacks("4:30 PM", "ET", "The latest slot each day is 4:30 PM."),
      ));

    it("a closing hour without ET fails on ET (what trials 1 and 3 of availability-weekend-after-hours fail on)", () =>
      failsWith(SLOT_HOURS(" and visits."), lacks("5:00 PM", "ET", SLOT_HOURS(" and visits."))));

    it.each([
      ["a first slot is not the last start", "The earliest slot is 9:00 AM ET"],
      ["a provider's 4:00 PM is not the last start", "Dr. Lee's latest slot is 4:00 PM ET"],
      ["the phrase after the time isn't covered", "4:30 PM ET is the latest slot"],
      ["whole words only", "The latest slots end at 4:30 PM ET"],
      ["whole words only, before the phrase", "The prelatest slot is 4:30 PM ET"],
      ["a phrase outside the list", "The final slot is 4:30 PM ET"],
      ["an hour that isn't a bound", "The clinic opens at 9:00 AM ET"],
      ["a bound hour with no lead phrase", "Dr. Lee has 5:00 PM ET"],
    ])("%s: %s needs a weekday", (_why, sentence) =>
      failsWith(`${sentence}.`, lacks(sentence.match(/\d+:\d+ [AP]M/)?.[0] ?? "", WEEKDAY, `${sentence}.`)),
    );
  });

  it("a latest-slot phrase in an earlier sentence doesn't count: the time needs a weekday", () =>
    failsWith(
      "That is the latest slot. Dr. Lee has 4:30 PM ET.",
      lacks("4:30 PM", WEEKDAY, "Dr. Lee has 4:30 PM ET."),
    ));

  describe("a one-day offer's closing question (r1/Q-3 (a)): the one day line names the day", () => {
    /** book-provider-not-accepting trial 3's offer, whole, as recorded. */
    const OFFER =
      trialEvents("book-provider-not-accepting", 3).flatMap((e) =>
        e.kind === "assistant" && e.text.includes("Would 3:00 PM ET with") ? [e.text] : [],
      )[0] ?? "";
    const QUESTION = "Would 3:00 PM ET with Dr. Alvarez work, or would you prefer a different time?";
    const DAY_LINE =
      "Thursday, October 8:\n- 2:00 PM ET\n- 2:30 PM ET\n- 3:00 PM ET\n- 3:30 PM ET\n- 4:00 PM ET";

    it("the recorded text passes", () => passes(OFFER));

    it("a lead-in over the same single day line passes too", () =>
      passes(`Dr. Alvarez has 3:00 PM ET open:\n\n${DAY_LINE}`));

    it("a second heading for the same date passes while it lists the time, and fails when it doesn't", async () => {
      await passes(`${OFFER}\n\nThursday, October 8:\n- 3:00 PM ET`);
      await failsWith(`${OFFER}\n\nThursday, October 8:\n- 2:00 PM ET`, lacks("3:00 PM", WEEKDAY, QUESTION));
    });

    const FIVE = QUESTION.replace("3:00", "5:00");
    it.each([
      ["a time the day line doesn't list", OFFER.replace(QUESTION, FIVE), "5:00 PM", FIVE],
      ["a second date, listing times", `${OFFER}\n\nFriday, October 9:\n- 3:00 PM ET`, "3:00 PM", QUESTION],
      ["a second date with no times", `${OFFER}\n\nFriday, October 9:`, "3:00 PM", QUESTION],
      ["no day line", QUESTION, "3:00 PM", QUESTION],
    ])("%s fails on the weekday", (_why, text, time, sentence) =>
      failsWith(text, lacks(time, WEEKDAY, sentence)),
    );

    it("a closing question without ET fails on ET", () =>
      failsWith(
        OFFER.replace("Would 3:00 PM ET with", "Would 3:00 PM with"),
        lacks("3:00 PM", "ET", QUESTION.replace("3:00 PM ET", "3:00 PM")),
      ));
  });

  describe('"between … and" (r1/Q-4 (a)): the range start takes the end\'s ET', () => {
    const SENTENCE =
      "The only option would be a weekday appointment, Monday through Friday, between 8:00 AM and 5:00 PM ET.";

    it("passes", () => passes(SENTENCE));
    it("title case passes, at the start of the text and after a tab", async () => {
      await passes("Monday through Friday, Between 8:00 AM and 5:00 PM ET.");
      await passes("Between 8:00 AM and 5:00 PM ET, Monday through Friday.");
      await passes("Monday through Friday, between\t8:00 AM and 5:00 PM ET.");
    });

    it.each([
      [
        "a time that isn't right after 'between'",
        "Monday through Friday, between 7:00 AM ET and 8:00 AM and 5:00 PM ET.",
        "8:00 AM",
        "Monday through Friday, between 7:00 AM ET and 8:00 AM and 5:00 PM ET.",
      ],
      [
        "more than 'and' in the gap",
        "Monday through Friday, between 8:00 AM and then 5:00 PM ET.",
        "8:00 AM",
        "Monday through Friday, between 8:00 AM and then 5:00 PM ET.",
      ],
      [
        "no between, a list",
        "On Monday, 9:30 AM and 10:00 AM ET are open.",
        "9:30 AM",
        "On Monday, 9:30 AM and 10:00 AM ET are open.",
      ],
      [
        "no ET on either end",
        "Monday through Friday, between 8:00 AM and 5:00 PM.",
        "8:00 AM",
        "Monday through Friday, between 8:00 AM and 5:00 PM.",
      ],
      [
        "a comma in the gap",
        "Monday through Friday, between 8:00 AM, and 5:00 PM ET.",
        "8:00 AM",
        "Monday through Friday, between 8:00 AM, and 5:00 PM ET.",
      ],
      [
        'more than "and" in the gap',
        "Monday through Friday, between 8:00 AM or 5:00 PM ET.",
        "8:00 AM",
        "Monday through Friday, between 8:00 AM or 5:00 PM ET.",
      ],
      [
        '"between" glued to the time\'s word',
        "Monday through Friday, inbetween 8:00 AM and 5:00 PM ET.",
        "8:00 AM",
        "Monday through Friday, inbetween 8:00 AM and 5:00 PM ET.",
      ],
    ])("%s fails on ET", (_why, text, time, sentence) => failsWith(text, lacks(time, "ET", sentence)));

    it('"between 8:00 AM and noon" has no range end, so it needs a weekday', () =>
      failsWith("Between 8:00 AM and noon ET.", lacks("8:00 AM", WEEKDAY, "Between 8:00 AM and noon ET.")));

    it('"Monday, November 2 at 9:00 AM and 11:30 AM" still yields two slots (RANGE_END is unchanged)', () => {
      expect(slotMentions("Monday, November 2 at 9:00 AM and 11:30 AM").map((m) => m.key)).toEqual([
        "11-02 09:00",
        "11-02 11:30",
      ]);
    });
  });

  describe("a held appointment's pair keeps its 40-character rule (r1/Q-5 (a))", () => {
    it("the reschedule trial's line still fails", async () => {
      const text =
        "I can see your Wednesday appointment with Dr. Anna Kowalski on October 7 at 4:00 PM ET for knee rehab. Let me check Thursday afternoon availability for physical therapy.";
      expect(failingSentences(text, true)).toEqual([]);
      expect(await timesCheck([ASKS, assistant(text), call("check_availability", {})])).toMatchObject({
        status: "fail",
        detail: '"October 7 at 4:00 PM" lacks a weekday or ET',
      });
    });
  });
});
