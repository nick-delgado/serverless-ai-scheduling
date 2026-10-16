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

/**
 * Markdown the plain-text chat bubble would show as raw characters (#233, r1/Q-2 (b)). `markdownIn` reads one line
 * at a time, so every pair is within one line:
 * - bold: a `**…**` or `__…__` pair within one line;
 * - italics: a single-asterisk pair `*…*` within one line, whose opening `*` has no space after it and whose
 *   closing `*` has no space before it, and neither is part of `**`, so a `* ` bullet (`LIST_ITEM_PREFIX`) never
 *   opens one;
 * - a heading: a line that starts with one to six `#` and a space.
 * Nothing else counts: a `#` inside a line ("#2"), a single underscore pair, a day line ending in a colon.
 */
export const MARKDOWN_EMPHASIS = [/(\*\*|__).+?\1/, /(?<!\*)\*(?![\s*])[^*]*?(?<![\s*])\*(?!\*)/] as const;
export const MARKDOWN_HEADING = /^#{1,6} /;

/** The first Markdown (`MARKDOWN_EMPHASIS`, `MARKDOWN_HEADING`) in `text`, as written, or undefined. */
export function markdownIn(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const heading = MARKDOWN_HEADING.exec(line);
    if (heading) return heading[0];
    for (const re of MARKDOWN_EMPHASIS) {
      const hit = re.exec(line);
      if (hit) return hit[0];
    }
  }
  return undefined;
}

/**
 * The handoff phrase counted per escalation turn (#233, r1/Q-3 (a)): "connect you with our front desk" or
 * "connect you with the front desk", any case. The clinic's phone number (`CLINIC.phone`) is counted too.
 */
export const HANDOFF_PHRASE = /connect you with (?:our|the) front desk/i;

/** Times the handoff phrase, and the clinic's phone number, appear in `text`. */
export function handoffCounts(text: string): { phrase: number; phone: number } {
  const phrase = text.match(new RegExp(HANDOFF_PHRASE.source, `${HANDOFF_PHRASE.flags}g`))?.length ?? 0;
  return { phrase, phone: text.split(CLINIC.phone).length - 1 };
}

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

/** The date half of `slotKey`: `10-15`. */
const dateKey = (month: number, day: number): string =>
  `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** How the graders key a dated time: month (1-12), day and a 24-hour `HH:MM`, as `10-15 14:00`. */
export const slotKey = (month: number, day: number, time: string): string => `${dateKey(month, day)} ${time}`;

/**
 * A month name and day as the graders read a date ("October 15", "Oct. 15th", "Sept 3"). With `capture`, the
 * month name and the day are capture groups 1 and 2; without it, there are no capture groups.
 */
const monthDay = (capture: boolean): string => {
  const open = capture ? "(" : "(?:";
  return `\\b${open}${MONTH_ALTERNATION})\\.?\\s+${open}\\d{1,2})(?:st|nd|rd|th)?\\b`;
};

/** The characters that end a sentence for the date readers, as a character-class body: `.;?!` and a newline. */
const SENTENCE_END = ".;?!\\n";

/** A clock time as `h:mm AM/PM`; hour, minute and the `a`/`p` of the period are capture groups 1 to 3. */
const CLOCK_TIME_SOURCE = "\\b(\\d{1,2}):(\\d{2})\\s*([ap])\\.?\\s?m\\.?";

/**
 * "<Month> <day> … <h:mm> AM|PM" pairs, with the time at most 40 characters after the date
 * ("October 15, 2026 at 2:00 PM ET", "Oct 15 at 2:00 PM"). Bare times ("2 PM") and bare dates are ignored.
 * Only the first time after a date pairs with it. The gap between the two can't cross a sentence
 * (`.;?!` or a newline), another month-day (so in "from October 13 to October 14 at 2:00 PM" the time is
 * October 14's), or the word "and" (so "the week of November 2 and 11:30 AM" is no mention; #98).
 */
export function dateTimeMentions(text: string): DateTimeMention[] {
  const gap = `(?:(?!${monthDay(false)}|\\band\\b)[^${SENTENCE_END}]){0,40}?`;
  const re = new RegExp(`${monthDay(true)}${gap}${CLOCK_TIME_SOURCE}`, "gi");
  const out: DateTimeMention[] = [];
  for (const m of text.matchAll(re)) {
    const [raw, month = "", day = "", hh = "", mm = "", period = ""] = m;
    const mi = monthIndex(month);
    if (mi < 0) continue;
    out.push({
      key: slotKey(mi + 1, Number(day), to24h(Number(hh), Number(mm), period)),
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

/** A dated time the slot check grades (`slotMentions`), with the position of its clock time. */
export interface SlotMention extends DateTimeMention {
  /** The clock time, 24-hour `HH:MM` (the time half of `key`). */
  time: string;
  /** Where the clock time starts in the text (for a `dateTimeMentions` pair, after the date). */
  timeIndex: number;
}

/** A clock time in a text: as written, where it starts, and as 24-hour `HH:MM`. */
interface ClockTime {
  raw: string;
  index: number;
  time: string;
}

/** A month-day in a text: month (1-12), day, and as written. */
interface NamedDate {
  month: number;
  day: number;
  raw: string;
}

/** Ends a sentence for `slotMentions`' later times: the characters `dateTimeMentions`' gap can't cross. */
const SENTENCE_BREAK = new RegExp(`[${SENTENCE_END}]`);
/** A gap that ends in one of these makes the next time a range end, which takes no date (#178, r1/Q-2 edges). */
const RANGE_END = /(?:\b(?:to|until|till)|[-–])\s*$/i;

const clockTimesIn = (text: string): ClockTime[] =>
  [...text.matchAll(new RegExp(CLOCK_TIME_SOURCE, "gi"))].map((match) => {
    const [raw, h = "", m = "", period = ""] = match;
    return { raw, index: match.index, time: to24h(Number(h), Number(m), period) };
  });

const datesIn = (text: string): NamedDate[] =>
  [...text.matchAll(new RegExp(monthDay(true), "gi"))].map(([raw, month = "", day = ""]) => ({
    month: monthIndex(month) + 1,
    day: Number(day),
    raw,
  }));

/** `t` dated `date`, as the slot check reads it; its `raw` is the date and the time as written, joined by " … ". */
const dated = (date: NamedDate, t: ClockTime): SlotMention => ({
  key: slotKey(date.month, date.day, t.time),
  raw: `${date.raw} … ${t.raw}`,
  index: t.index,
  time: t.time,
  timeIndex: t.index,
});

/**
 * The `dateTimeMentions` pairs, each followed by the later times in its sentence, which take its date
 * (#178, r1/Q-2 (a)): "Monday, November 2 at 9:00 AM and 11:30 AM" yields both. A range end (a time right
 * after "to", "until", "till", "-" or "–") takes no date. The sentence ends at `SENTENCE_BREAK` or another
 * month-day.
 */
function pairsAndLaterTimes(text: string, times: readonly ClockTime[]): SlotMention[] {
  const out: SlotMention[] = [];
  for (const pair of dateTimeMentions(text)) {
    const end = pair.index + pair.raw.length;
    // The pair's own time is the last one that starts inside it.
    const own = times.filter((t) => t.index < end).reduce((_, t) => t);
    out.push({ ...pair, time: own.time, timeIndex: own.index });
    // A pair holds one month-day: its gap can't cross another.
    for (const date of datesIn(pair.raw)) {
      let from = end;
      for (const t of times.filter((x) => x.index >= end)) {
        const gap = text.slice(from, t.index);
        if (SENTENCE_BREAK.test(gap) || datesIn(gap).length > 0) break;
        if (!RANGE_END.test(gap)) out.push(dated(date, t));
        from = t.index + t.raw.length;
      }
    }
  }
  return out;
}

/** A clock time listed under a date heading (`headingListTimes`): a slot mention, plus its two lines. */
export interface HeadingListTime extends SlotMention {
  /** The heading line that dates it, as written (the weekday check reads its weekday here, #236). */
  heading: string;
  /** The rest of the time's own line, from the end of the clock time (the weekday check reads ET here, #236). */
  afterTime: string;
}

/**
 * The clock times on list lines (`LIST_ITEM_PREFIX`) under a date heading, dated by it (#178, r1/Q-2 (a)). A
 * date heading is any line that names a month-day, and gives its last one. Its reach runs over blank lines and
 * list lines, and ends at the next line that names a month-day or at the first other non-blank line, so a
 * weekday-only line ("Tuesday:") ends it and gives no date. It walks every line, not only `listItemLines`,
 * because the blank, prose and heading lines decide the reach. It serves both the slot check (`slotMentions`)
 * and `times_in_clinic_tz_with_weekday` (#236, r2/Q-1 (a)), which reads each time's `heading` and `afterTime`.
 */
export function headingListTimes(
  text: string,
  times: readonly ClockTime[] = clockTimesIn(text),
): HeadingListTime[] {
  const out: HeadingListTime[] = [];
  let heading: { date: NamedDate; line: string } | undefined;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const named = datesIn(line).at(-1);
    if (named !== undefined) heading = { date: named, line };
    else if (LIST_ITEM_PREFIX.test(line)) {
      const h = heading;
      if (h !== undefined)
        out.push(
          ...times
            .filter((t) => t.index >= lineStart && t.index < lineStart + line.length)
            .map((t) => ({
              ...dated(h.date, t),
              heading: h.line,
              afterTime: line.slice(t.index - lineStart + t.raw.length),
            })),
        );
    } else if (line.trim() !== "") heading = undefined;
    lineStart += line.length + 1;
  }
  return out;
}

/**
 * Every dated clock time in `text`, for `no_hallucinated_slots` (#178, r1/Q-2 (a), r1/A-1): the
 * `dateTimeMentions` pairs and the later times in their sentence (`pairsAndLaterTimes`, which only this check
 * reads), and the list-line times under a date heading (`headingListTimes`, which the weekday check reads too,
 * #236). `dateTimeMentions` stays as it is for its other callers. Times on a heading line itself are read as
 * `dateTimeMentions` reads them. Sorted by `timeIndex`.
 */
export function slotMentions(text: string): SlotMention[] {
  const times = clockTimesIn(text);
  return [...pairsAndLaterTimes(text, times), ...headingListTimes(text, times)].sort(
    (a, b) => a.timeIndex - b.timeIndex,
  );
}

/**
 * The words that, right before one of the clinic's opening-hours bounds, make it the clinic's hours rather
 * than a slot (#244, r1/Q-4 (a)). The list is complete: a new wording is graded until it is added here.
 */
const CLINIC_HOURS_LEAD =
  /\b(?:open until|open till|opens at|closes at|close at|closing at|clinic is open is|open from|hours are)[ \t]+$/i;

/**
 * Whether `mention` is the clinic's hours (#244, r1/Q-4 (a)): its time is `CLINIC.openHour` or
 * `CLINIC.closeHour` on the hour (8:00 AM or 5:00 PM), and the words right before that time, in the same
 * sentence, are a `CLINIC_HOURS_LEAD` phrase. "Dr. Lee has Tuesday, October 6 at 5:00 PM ET" stays a slot.
 */
export function namesClinicHours(text: string, mention: SlotMention): boolean {
  const bound = [CLINIC.openHour, CLINIC.closeHour].some((h) => mention.time === hhmm(h, 0));
  return bound && CLINIC_HOURS_LEAD.test(text.slice(0, mention.timeIndex));
}

/** The clinic timezone as written after a time: `CLINIC.timezoneAbbrev` (ET) or a DST spelling. */
const ZONE_RE = new RegExp(`\\b(${CLINIC.timezoneAbbrev}|EDT|EST|Eastern)\\b`);

/**
 * Whether a date+time mention carries a weekday and the clinic timezone (`ET`/`Eastern` within 16 characters
 * after the time). For a `dateTimeMentions` pair, the weekday is within 40 characters before it, and after
 * the `previous` mention, so a second time can't borrow the first one's weekday. For a time listed under a
 * day line (`headingListTimes`, #236, r1/Q-2 (a)), the weekday is on its heading line and ET is on the
 * time's own line: "Tuesday, October 13:\n- 1:00 PM ET" passes; "October 13:\n- 1:00 PM ET" and
 * "Tuesday, October 13:\n- 1:00 PM" fail.
 */
export function mentionHasWeekdayAndZone(
  text: string,
  mention: DateTimeMention | HeadingListTime,
  previous?: DateTimeMention,
): boolean {
  if ("heading" in mention)
    return WEEKDAY_RE.test(mention.heading) && ZONE_RE.test(mention.afterTime.slice(0, 16));
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
