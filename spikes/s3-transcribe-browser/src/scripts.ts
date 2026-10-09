/**
 * The three fixed utterance scripts (r1/Q-6 (a)). Nick reads one aloud into the device being
 * measured and presses Send right after the last word; the 60 s script is a little longer than
 * 60 s, so it runs into the page's 60 s auto-send (FR-021). Everyone named here is fictional
 * (CLAUDE.md rule 6): the demo patients and Dr. Priya Lee come from the clinic-default fixture.
 *
 * The README repeats these texts; keep the two copies in sync.
 */

export type Length = "5s" | "20s" | "60s";

export const LENGTHS: readonly Length[] = ["5s", "20s", "60s"];

export const SCRIPTS: Record<Length, string> = {
  "5s": "Hi, this is Maria Santos. Can I see Doctor Lee next Tuesday morning?",
  "20s":
    "Hello, this is Walter Haines. I need to move my appointment at Cedar Ridge Health. " +
    "I'm booked with Doctor Lee on Thursday at two in the afternoon, but I have a conflict at work. " +
    "Is there anything open on Friday, or early next week, preferably before noon? Thank you.",
  "60s":
    "Good morning, my name is Aisha Rahman, and I'm a patient at Cedar Ridge Health. " +
    "I'd like to book a dermatology appointment with Doctor Priya Lee, if she's taking new visits this month. " +
    "I've had a dry, itchy patch on my left forearm for about three weeks now. " +
    "It isn't painful, and it hasn't spread, but the cream I bought at the pharmacy hasn't helped much. " +
    "My schedule is a little complicated. On Mondays and Wednesdays I work until five thirty, " +
    "so those days only work if there's something after six. " +
    "Tuesdays and Thursdays are better, any time before three in the afternoon. " +
    "Fridays I can do almost anything, except between eleven and one. " +
    "If Doctor Lee is fully booked, I'd be happy to see another dermatologist in the clinic instead. " +
    "Could you also tell me whether I need to bring anything to the visit, like a list of medications? " +
    "And please send the confirmation to the email address on my profile, not by text message. " +
    "One more thing: if a slot opens up earlier because someone cancels, I'd like to take it. Thanks so much for your help.",
};

/**
 * The browser labels (r1/Q-2, r1/A-7), shared by the page and `summarize.ts`. `index.html`'s
 * "Browser being measured" options repeat them; keep the two in sync.
 */
export const MEASURED_BROWSERS: readonly string[] = [
  "ios-safari",
  "android-chrome",
  "chrome-desktop",
  "safari-macos",
];
export const BEST_EFFORT_BROWSERS: readonly string[] = ["firefox", "edge"];
/** The r1/A-2 (corrected) stabilization variant runs on these only. */
export const VARIANT_BROWSERS: readonly string[] = ["chrome-desktop", "ios-safari"];

/** r1/Q-2 and r1/Q-4 count a run unless it was a deliberate check (reload, lock screen, tab switch). */
export const countsTowardRule = (run: { check: string }): boolean => run.check === "none";

/** Run targets per length: r1/Q-4 (a) for the main runs, r1/A-2 (corrected) for the variant. */
export const MAIN_TARGET: Record<Length, number> = { "5s": 7, "20s": 7, "60s": 6 };
export const VARIANT_TARGET: Record<Length, number> = { "5s": 5, "20s": 5, "60s": 5 };
/** r1/A-7: Firefox and Edge get up to 3 utterances in total, best effort. */
export const BEST_EFFORT_TOTAL = 3;
