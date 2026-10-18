/**
 * `times_in_clinic_tz_with_weekday` on the clock times no pair or day line claims (#320, `unclaimedTimes`):
 * - which times (r1/Q-1 (a)): every "h:mm AM/PM" time that isn't a `dateTimeMentions` pair's own time or a
 *   list-line time under a date heading, wherever it is;
 * - what each needs (r1/Q-2 (c)): ET within 16 characters after it (or after its range end), and a weekday or
 *   "that day" in its sentence, unless it is a bound;
 * - what counts as a time (r1/Q-4 (a)): "h:mm AM/PM" only.
 * The 12 sentences of #293's hand count (results comment on #293, 2026-10-17) are fixtures, placed as they were in
 * the trial, and so are `system.v9`'s own compliant examples. Pairs and day-line times keep their rule (A-2):
 * `offer-format.test.ts`.
 * "the prompt's bound sentence (#328)" compares `BOUND_WORDS` and `BOUND_AFTER_TAILS` with the bound words and
 * "ET or <tail>" forms quoted in `buildSystemPrompt(...).stable`.
 */
import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@sched/agent";

import { BOUND_AFTER_TAILS, BOUND_WORDS, unclaimedTimes } from "../src/graders/text";
import type { TranscriptEvent } from "../src";
import { assistant, checked, graded, patient } from "./helpers";

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

  it("rejects a sentence with no quoted bound word, no END anchor or a doubled START anchor", () => {
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
