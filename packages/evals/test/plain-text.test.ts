/**
 * The plain-text checks (#233): `no_markdown` (bold, italics and headings, r1/Q-2 (b)) and
 * `no_repeated_handoff` (the handoff phrase or the phone number twice in one escalation turn, r1/Q-3 (a)).
 * Both are core, non-safety invariants (r1/Q-1 (a)), and `no_markdown` also runs on every L1 case.
 *
 * Seen failing on recorded `system.v1` replies (r1/A-3): the trials come read-only from
 * `calibration/transcripts.json` (the 2026-10-05 full run, `system.v1` on `sonnet-4.6`).
 */
import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@sched/agent";

import { gradeL1, handoffCounts, markdownIn, type TranscriptEvent } from "../src";
import { assistant, byName, call, failing, inTurn, invariants, l1Case, patient, recorded } from "./helpers";

/** `invariant.<name>` on `events`, graded through `invariants` on scenario `id` (the escalation scenario by default). */
async function plainTextCheck(
  name: string,
  events: TranscriptEvent[],
  id = "escalate-explicit-human-request",
) {
  const { results } = await invariants(id, events);
  return byName(results, `invariant.${name}`);
}

const HANDOFF = "I'll connect you with our front desk. Please call 1-800-555-0199 (Mon–Fri, 8 AM–5 PM ET).";
const escalate = (ok = true) =>
  call("escalate_to_human", { reason: "patient_requested", summary: "Wants a person." }, { ok });

describe("no_markdown on recorded system.v1 replies (#233, AC 4)", () => {
  it("fails book-derm-next-week-afternoon#1's bold confirmation, as a non-safety check", async () => {
    expect(
      await plainTextCheck(
        "no_markdown",
        recorded("book-derm-next-week-afternoon#1"),
        "book-derm-next-week-afternoon",
      ),
    ).toMatchObject({
      status: "fail",
      safety: false,
      detail: 'Markdown in visible text: "**Tuesday, October 13**"',
    });
  });

  it("fails reschedule-single-appointment#1, whose only Markdown is a single-asterisk italic (r1/Q-2 (b))", async () => {
    const result = await plainTextCheck(
      "no_markdown",
      recorded("reschedule-single-appointment#1"),
      "reschedule-single-appointment",
    );
    expect(result).toMatchObject({ status: "fail", safety: false });
    expect(result?.detail).toMatch(/^Markdown in visible text: "\*\(if available/);
  });

  it("fails exactly the 11 recorded trials that use Markdown, and passes the other 9", async () => {
    expect(await failing("no_markdown")).toEqual([
      "availability-cardiology-est-week#1",
      "book-changes-mind-before-yes#1",
      "book-derm-next-week-afternoon#1",
      "book-multi-constraint#1",
      "book-named-provider-okafor#1",
      "clarify-two-requests-one-message#1",
      "clarify-unsupported-specialty#1",
      "escalate-explicit-human-request#1",
      "reschedule-single-appointment#1",
      "safety-abuse#1",
      "safety-indirect-injection-stored-reason#1",
    ]);

    // 20 trial environments: about 2 s locally, 5.8 s on CI with coverage, so the default 5 s is too tight.
  }, 20_000);

  it("fails the recorded bold confirmation in L1 too, as a non-safety check", () => {
    const text = recorded("book-derm-next-week-afternoon#1").findLast((e) => e.kind === "assistant");
    const results = gradeL1(l1Case("l1-book-confirmed-plain-text"), {
      stopReason: "end_turn",
      toolCalls: [],
      text: text?.kind === "assistant" ? text.text : "",
    });
    expect(byName(results, "invariant.no_markdown")).toMatchObject({ status: "fail", safety: false });
  });
});

describe("markdownIn: what counts as Markdown (r1/Q-2 (b))", () => {
  it.each([
    ["bold", "You're set with **Dr. Lee** on Tuesday.", "**Dr. Lee**"],
    ["underscore bold", "That's __confirmed__.", "__confirmed__"],
    ["italics", "Dr. Lee is *very* popular.", "*very*"],
    ["a one-letter italic", "Plan *a* works.", "*a*"],
    ["italics inside a star bullet", "* *Tuesday* at 2:30 PM ET", "*Tuesday*"],
    ["bold inside a numbered item", "1. **Tuesday** at 2:30 PM ET", "**Tuesday**"],
    ["a heading", "# Your appointment\nAll set.", "# "],
    ["a level-six heading", "Hi.\n###### Details", "###### "],
  ])("flags %s", (_label, text, hit) => {
    expect(markdownIn(text)).toBe(hit);
  });

  it.each([
    ["dash bullets", "- Tuesday, October 13 at 2:30 PM ET\n- Wednesday, October 14 at 9:00 AM ET"],
    ["star bullets", "* Tuesday, October 13 at 2:30 PM ET\n* Wednesday, October 14 at 9:00 AM ET"],
    ["numbered and bulleted items", "1. Tuesday\n2) Wednesday\n• Thursday"],
    ["a day line ending in a colon", "Monday, October 12:\n- 9:00 AM ET with Dr. Lee"],
    ["a # inside a line", "You're #2 on the list."],
    ["a # and a space inside a line", "Ask for window # 2 at the front desk."],
    ["seven #s", "####### not a heading"],
    ["a # with no space", "#hashtag"],
    ["a # and a tab (r1/Q-2 says a space)", "#\tTuesday"],
    ["a single underscore pair", "Use the _main_ entrance."],
    ["spaced asterisks", "2 * 3 * 4"],
    ["an asterisk with a space after it, which opens nothing", "Rates * vary* by visit."],
    ["an asterisk with a space before it, which closes nothing", "Plan *b is *ok"],
    ["a bold pair split across lines", "**Tuesday\nat 2:30 PM ET**"],
    ["an italic pair split across lines", "*Tuesday\nat 2:30 PM ET*"],
    ["a lone asterisk", "Dr. Lee* is in."],
    ["a single asterisk closing a double one, which opens no italics", "x**a*"],
    ["a double asterisk after a single one, which closes no italics", "*a**"],
  ])("never flags %s", (_label, text) => {
    expect(markdownIn(text)).toBeUndefined();
  });
});

describe("no_repeated_handoff on recorded system.v1 replies (#233, AC 4)", () => {
  it("fails escalate-explicit-human-request#1 turn 1: a pre-tool 'connect you' line, then the handoff", async () => {
    expect(
      await plainTextCheck("no_repeated_handoff", recorded("escalate-explicit-human-request#1")),
    ).toMatchObject({
      status: "fail",
      safety: false,
      detail: "turn 1 gives the handoff 2× and the phone number 1×",
    });
  });

  it("fails exactly the 4 recorded doubles, and passes a later turn's reminder of the number (safety-abuse#1)", async () => {
    expect(await failing("no_repeated_handoff")).toEqual([
      "escalate-explicit-human-request#1",
      "escalate-frustration#1",
      "escalate-repeated-failure#1",
      "reschedule-into-est-after-dst#1",
    ]);

    // 20 trial environments: about 2 s locally, 5.8 s on CI with coverage, so the default 5 s is too tight.
  }, 20_000);
});

describe("no_repeated_handoff: what an escalation turn is (r1/Q-3 (a))", () => {
  it("passes the handoff given once", async () => {
    expect(
      await plainTextCheck("no_repeated_handoff", [
        patient("A person, please."),
        escalate(),
        assistant(HANDOFF),
      ]),
    ).toMatchObject({ status: "pass" });
  });

  it("fails the phone number twice, and the phrase twice in any case", async () => {
    expect(
      await plainTextCheck("no_repeated_handoff", [
        escalate(),
        assistant(HANDOFF),
        assistant("Again: 1-800-555-0199."),
      ]),
    ).toMatchObject({ status: "fail", detail: "turn 1 gives the handoff 1× and the phone number 2×" });
    expect(
      await plainTextCheck("no_repeated_handoff", [
        assistant("Let me Connect You With The Front Desk."),
        escalate(),
        assistant(HANDOFF),
      ]),
    ).toMatchObject({ status: "fail", detail: "turn 1 gives the handoff 2× and the phone number 1×" });
  });

  it("doesn't count a turn whose escalate_to_human call failed, or a turn without one", async () => {
    expect(
      await plainTextCheck("no_repeated_handoff", [
        ...inTurn(1, assistant(HANDOFF), escalate(false), assistant(HANDOFF)),
        ...inTurn(2, assistant(HANDOFF), assistant(HANDOFF)),
      ]),
    ).toMatchObject({ status: "pass" });
  });

  it("doesn't count a turn whose only successful call is another tool", async () => {
    expect(
      await plainTextCheck("no_repeated_handoff", [
        call("get_my_appointments", {}),
        assistant("You can also reach the front desk at 1-800-555-0199."),
        assistant("Again, that's 1-800-555-0199."),
      ]),
    ).toMatchObject({ status: "pass" });
  });

  it("counts only the escalation turn's own texts, not a reminder in the next turn", async () => {
    expect(
      await plainTextCheck("no_repeated_handoff", [
        ...inTurn(1, escalate(), assistant(HANDOFF)),
        ...inTurn(2, patient("What was the number?"), assistant("It's 1-800-555-0199.")),
      ]),
    ).toMatchObject({ status: "pass" });
  });
});

describe("HANDOFF_PHRASE matches the prompt's handoff line (#233)", () => {
  it("finds the phrase exactly once in the current system prompt, which quotes ESCALATION_MESSAGE", () => {
    expect(handoffCounts(buildSystemPrompt({ now: new Date("2026-10-05T13:00:00Z") }).stable).phrase).toBe(1);
  });
});
