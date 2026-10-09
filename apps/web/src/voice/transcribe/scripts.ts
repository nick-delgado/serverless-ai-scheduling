/**
 * The three utterance scripts for AC6's runs (#29 r2/Q-2 edges), shown by the timing panel so the
 * tester reads them off the device. A copy of `SCRIPTS` in `spikes/s3-transcribe-browser/src/
 * scripts.ts` (the spike stays as it is, and apps don't import spikes); keep the two in sync. Everyone
 * named is fictional (CLAUDE.md rule 6). The 60 s script runs a little past 60 s, into the auto-send.
 */
import type { Clip } from "./timing";

export const SCRIPTS: Record<Clip, string> = {
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
