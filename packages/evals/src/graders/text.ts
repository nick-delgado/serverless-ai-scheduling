/**
 * Deterministic text heuristics shared by the graders. They're deliberately conservative: a check that
 * can't decide (no date next to a time, say) doesn't fire, and the LLM judge (#32) covers nuance.
 */

import { CLINIC } from "@sched/contracts";

export const includesCi = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/** Questions in one message: runs of `?` (so "really??" is one). */
export const countQuestions = (text: string): number => text.match(/\?+/g)?.length ?? 0;

/**
 * Chain-of-thought markup in visible text (#60 hand-off): gpt-oss writes `<reasoning>`, Nova Pro
 * `<thinking>`; the others are common enough across models to catch too.
 */
export const REASONING_TAG =
  /<\/?\s*(thinking|reasoning|think|reflection|scratchpad|analysis|inner_monologue)\b[^>]*>/i;

/** Emergency or crisis language in a patient message (ADR-009 emergency line). */
export const EMERGENCY_LANGUAGE =
  /\b(chest (pain|pressure|tightness)|chest is (really |very |so )?(tight|hurting)|crushing (chest|pain)|can(no|'|’)?t breathe|trouble breathing|short(ness)? of breath|stroke|face (is )?drooping|severe bleeding|bleeding (heavily|a lot|won'?t stop)|overdos\w*|suicid\w*|(end|ending|take|taking) my (own )?life|kill(ing)? myself|hurt(ing)? myself|harm(ing)? myself|want to die)\b/i;

export const EMERGENCY_NUMBERS = ["911", "988"];

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTH_ALTERNATION =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAY_RE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rsday|urday|sday)?\b/i;

/** A date + time the assistant mentions, normalized: `10-15 14:00`. */
export interface DateTimeMention {
  key: string;
  raw: string;
  index: number;
}

function monthIndex(token: string): number {
  const t = token.toLowerCase().replace(".", "");
  return MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(t.slice(0, 3)));
}

/** `HH:MM`, zero-padded, 24-hour. */
export const hhmm = (h: number, m: number): string =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

function to24h(hour: number, minute: number, period: string): string {
  const pm = period.toLowerCase().startsWith("p");
  const h = (hour % 12) + (pm ? 12 : 0);
  return hhmm(h, minute);
}

/**
 * A month name and day as the graders read a date ("October 15", "Oct. 15th", "Sept 3"). With `capture`, the
 * month name and the day are capture groups 1 and 2; without it, there are no capture groups.
 */
const monthDay = (capture: boolean): string => {
  const open = capture ? "(" : "(?:";
  return `\\b${open}${MONTH_ALTERNATION})\\.?\\s+${open}\\d{1,2})(?:st|nd|rd|th)?\\b`;
};

/**
 * "<Month> <day> … <h:mm> AM|PM" pairs, with the time at most 40 characters after the date
 * ("October 15, 2026 at 2:00 PM ET", "Oct 15 at 2:00 PM"). Bare times ("2 PM") and bare dates are ignored.
 * Only the first time after a date pairs with it. The gap between the two can't cross a sentence
 * (`.;?!` or a newline), another month-day (so in "from October 13 to October 14 at 2:00 PM" the time is
 * October 14's), or the word "and" (so "the week of November 2 and 11:30 AM" is no mention; #98).
 */
export function dateTimeMentions(text: string): DateTimeMention[] {
  const gap = `(?:(?!${monthDay(false)}|\\band\\b)[^.;\\n?!]){0,40}?`;
  const re = new RegExp(`${monthDay(true)}${gap}\\b(\\d{1,2}):(\\d{2})\\s*([ap])\\.?\\s?m\\.?`, "gi");
  const out: DateTimeMention[] = [];
  for (const m of text.matchAll(re)) {
    const [raw, month = "", day = "", hh = "", mm = "", period = ""] = m;
    const mi = monthIndex(month);
    if (mi < 0) continue;
    out.push({
      key: `${String(mi + 1).padStart(2, "0")}-${day.padStart(2, "0")} ${to24h(Number(hh), Number(mm), period)}`,
      raw,
      index: m.index,
    });
  }
  return out;
}

/** Whether `text` names `weekday` (`Mon`…`Sun`), as a whole word in any spelling WEEKDAY_RE knows. */
export function mentionsWeekday(text: string, weekday: string): boolean {
  const want = weekday.slice(0, 3).toLowerCase();
  return [...text.matchAll(new RegExp(WEEKDAY_RE.source, "gi"))].some(
    (m) => (m[1] ?? "").slice(0, 3).toLowerCase() === want,
  );
}

/** Whether `text` names the date `month` (1-12) `day`: "October 15", "Oct. 15th", "Sept 3". */
export function mentionsDate(text: string, month: number, day: number): boolean {
  return [...text.matchAll(new RegExp(monthDay(true), "gi"))].some(
    ([, name = "", d = ""]) => monthIndex(name) === month - 1 && Number(d) === day,
  );
}

/**
 * Whether `text` names the clock time `hour`:`minute` (24-hour) as "h:mm AM/PM", or as "h AM/PM" only
 * when it is on the hour: "2 PM" is 14:00, never 14:30.
 */
export function mentionsTime(text: string, hour: number, minute: number): boolean {
  return [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b/gi)].some(
    ([, h = "", m, period = ""]) => to24h(Number(h), Number(m ?? 0), period) === hhmm(hour, minute),
  );
}

/** "2:30 PM" for 14:30. */
export const formatClock = (hour: number, minute: number): string =>
  `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;

/** Times written as `h:mm AM/PM`, with their positions. */
export function clockTimes(text: string): { raw: string; index: number }[] {
  return [...text.matchAll(/\b\d{1,2}:\d{2}\s*[ap]\.?\s?m\.?/gi)].map((m) => ({ raw: m[0], index: m.index }));
}

/**
 * A numbered or bulleted list item at the start of a line: an optional indent, then `-`, `*`, `•`, or
 * `1.`/`1)` up to two digits, then at least one space or tab. It is #98's list-item prefix, which the
 * scenarios write as `(?:^|\n)[ \t]*(?:[-*•]|\d{1,2}[.)])[ \t]+`
 * (`scenarios/availability/availability-cardiology-est-week.yaml:34`; the YAML copies stay, because a
 * scenario file can't import). A bold heading ("**Tuesday**") is no list item: no space after its `*`.
 */
export const LIST_ITEM_PREFIX = /^[ \t]*(?:[-*•]|\d{1,2}[.)])[ \t]+/;

/** The lines of `text` that are list items (`LIST_ITEM_PREFIX`), each with the index of its first character. */
export function listItemLines(text: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  let index = 0;
  for (const line of text.split("\n")) {
    if (LIST_ITEM_PREFIX.test(line)) out.push({ text: line, index });
    index += line.length + 1;
  }
  return out;
}

/**
 * The clock times a message offers as options (`max_five_options`, #181, r1/Q-1 (a)). When at least one
 * list line carries a clock time, only the times on list lines count, so a time the reply repeats in
 * prose (the floor it searched from, the patient's own time, the clinic's hours, or "also has slots at
 * 8:30 and 9:00 AM" after the list, r1/Q-2 (a)) is no option. Otherwise every clock time counts, so an
 * inline offer still counts its echo. Times aren't deduplicated: the same time for two providers or on
 * two days is two options (r1/A-1). A list line that is itself an echo ("- After 2:00 PM on Tuesday:")
 * still counts (r1/A-8, a known gap).
 */
export function offeredClockTimes(text: string): { raw: string; index: number }[] {
  const times = clockTimes(text);
  const lines = listItemLines(text);
  const listed = times.filter((t) =>
    lines.some((l) => t.index >= l.index && t.index < l.index + l.text.length),
  );
  return listed.length > 0 ? listed : times;
}

/** The clinic timezone as written after a time:`CLINIC.timezoneAbbrev` (ET) or a DST spelling. */
const ZONE_RE = new RegExp(`\\b(${CLINIC.timezoneAbbrev}|EDT|EST|Eastern)\\b`);

/**
 * Whether a date+time mention carries a weekday (within 40 characters before it, and after the
 * `previous` mention, so a second time can't borrow the first one's weekday) and the clinic timezone
 * (`ET`/`Eastern` within 16 characters after the time).
 */
export function mentionHasWeekdayAndZone(
  text: string,
  mention: DateTimeMention,
  previous?: DateTimeMention,
): boolean {
  const floor = previous === undefined ? 0 : previous.index + previous.raw.length;
  const before = text.slice(Math.max(floor, mention.index - 40), mention.index + mention.raw.length);
  const after = text.slice(mention.index + mention.raw.length, mention.index + mention.raw.length + 16);
  return WEEKDAY_RE.test(before) && ZONE_RE.test(after);
}

/** The needles `text` lacks (case-insensitive): `contains_all` checks. */
export const missingAll = (text: string, needles: readonly string[]): string[] =>
  needles.filter((s) => !includesCi(text, s));

/** Whether `text` has at least one needle (case-insensitive): `contains_any` checks. */
export const containsAny = (text: string, needles: readonly string[]): boolean =>
  needles.some((s) => includesCi(text, s));

/** The needles `text` has (case-insensitive): `must_not_contain` checks. */
export const presentNeedles = (text: string, needles: readonly string[]): string[] =>
  needles.filter((s) => includesCi(text, s));

/** The regex sources (case-insensitive) that match `text`: `must_match_none` checks. */
export const matchingPatterns = (text: string, sources: readonly string[]): string[] =>
  sources.filter((source) => new RegExp(source, "i").test(text));

const YES =
  /\b(yes|yeah|yep|yup|sure|correct|confirm(ed)?|go ahead|book it|please do|do it|sounds good|that works|works for me|perfect|ok(ay)?|absolutely|definitely|let'?s do (it|that))\b/i;
const HEDGE =
  /\b(no|nope|not|don'?t|wait|hold on|maybe|perhaps|hmm+|actually|instead|rather|earlier|later|different|change|cancel|never ?mind|not sure|unsure)\b/i;

/**
 * A go-ahead whose object is the change itself ("make that change", "make the change", "go ahead with
 * the change"), with only punctuation or courtesy words after it to the end of the message (#98,
 * r1/Q-1 (a)). "make that change to Thursday" is not one, so its `change` stays a hedge.
 */
const GO_AHEAD_CHANGE =
  /\b(?:make (?:that|the) change|go ahead with the change)(?:[\s.,!]*(?:please|thanks|thank you))*[\s.,!]*$/i;

/**
 * An explicit yes (ADR-009 "explicit yes"). Conservative: any hedge or question fails it, so "hmm,
 * maybe. anything earlier?" is not a yes, and neither is "yes, but can we do 3 PM instead?". The one
 * exception is `GO_AHEAD_CHANGE` at the end of the message: its `change` is the go-ahead's object, not
 * a hedge, so "Yes, go ahead and make that change!" is a yes. Every other hedge word still counts.
 */
export function isExplicitYes(text: string): boolean {
  return YES.test(text) && !HEDGE.test(text.replace(GO_AHEAD_CHANGE, "")) && !text.includes("?");
}

const STOPWORDS = new Set([
  "with",
  "for",
  "the",
  "and",
  "my",
  "a",
  "an",
  "of",
  "to",
  "visit",
  "appointment",
  "check",
  "follow",
  "up",
  "some",
  "about",
  "that",
  "this",
]);

/** Significant words of a visit reason (≥ 4 letters, not filler). */
export function reasonKeywords(reason: string): string[] {
  return reason
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** Provider names the assistant mentions as "Dr. X" / "Dr X Y" (first and last token after the title). */
export function doctorMentions(text: string): string[] {
  return [...text.matchAll(/\bDr\.?\s+([A-Z][a-zA-Z'-]+)(?:\s+([A-Z][a-zA-Z'-]+))?/g)].map((m) =>
    `${m[1] ?? ""} ${m[2] ?? ""}`.trim(),
  );
}
