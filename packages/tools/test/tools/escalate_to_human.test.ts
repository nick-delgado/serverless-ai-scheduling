import { CLINIC, TOOLS, type ConversationMessage, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import { RecordingNotifier, type Notifier } from "../../src/notify";
import {
  createToolExecutor,
  TOOL_REGISTRY,
  type ToolContext,
  type ToolExecutionResult,
  type ToolRegistry,
} from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import type { Repositories } from "../../src/repos/types";
import { escalateToHuman, ID_PLACEHOLDER } from "../../src/tools/escalate_to_human";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const UNKNOWN = "0b3c5d7e-1f2a-4b6c-8d9e-0a1b2c3d4e5f"; // valid v4 UUID, not in the fixture
const CONV = EXAMPLES.ConversationId;
const OTHER_CONV = "d4e5f6a7-8b9c-4d0e-9f1a-2b3c4d5e6f70";

const INPUT = {
  reason: "patient_requested",
  summary: "Patient wants to discuss a billing question with a person. Nothing was booked.",
} as const;

const outputOf = (r: ToolExecutionResult): ToolOutput<"escalate_to_human"> => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return TOOLS.escalate_to_human.output.parse(r.output);
};
const errorOf = (r: ToolExecutionResult): ToolError["error"] => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error.error;
};

/** A stored exchange with every block type; the SECRET_* strings must never reach staff. */
const conversation = (conversationId: string, at: string): ConversationMessage[] => [
  {
    conversationId,
    seq: 0,
    role: "user",
    content: [{ type: "text", text: "I need to talk to someone about my bill." }],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
  {
    conversationId,
    seq: 1,
    role: "assistant",
    content: [
      {
        type: "reasoning",
        family: "anthropic.claude",
        modelId: "us.anthropic.claude-sonnet-4-6",
        text: "SECRET_REASONING billing is out of scope",
        signature: "SECRET_SIGNATURE",
      },
      { type: "text", text: "Let me check your profile first." },
      { type: "tool_use", id: "toolu_1", name: "get_patient_profile", input: { note: "SECRET_TOOL_INPUT" } },
    ],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
  {
    conversationId,
    seq: 2,
    role: "user",
    content: [{ type: "tool_result", toolUseId: "toolu_1", content: '{"first_name":"SECRET_TOOL_RESULT"}' }],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
  {
    conversationId,
    seq: 3,
    role: "assistant",
    content: [
      { type: "text", text: "Billing is handled by our front desk." },
      { type: "text", text: "   " },
      { type: "text", text: "I can connect you with them." },
    ],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
];

describe("escalate_to_human", () => {
  let repos: InMemoryRepositories;
  let clock: FrozenClock;
  let notifier: RecordingNotifier;

  const run = (
    patientId: string,
    input: unknown = INPUT,
    opts: {
      notifier?: Notifier | null;
      repos?: Repositories;
      conversationId?: string;
      registry?: ToolRegistry;
    } = {},
  ): Promise<ToolExecutionResult> => {
    const n = opts.notifier === null ? undefined : (opts.notifier ?? notifier);
    const ctx: ToolContext = {
      patientId,
      conversationId: opts.conversationId ?? CONV,
      clock,
      repos: opts.repos ?? repos,
      ...(n ? { notifier: n } : {}),
    };
    return createToolExecutor(opts.registry ?? { escalate_to_human: escalateToHuman }, ctx).execute({
      id: "toolu_test",
      name: "escalate_to_human",
      input,
    });
  };

  beforeEach(async () => {
    const fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow);
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
    notifier = new RecordingNotifier();
    await repos.conversations.append(MARIA, conversation(CONV, clock.now().toISOString()));
  });

  it("is registered in TOOL_REGISTRY, so the model is offered it and calls reach this handler", async () => {
    const ctx: ToolContext = { patientId: MARIA, conversationId: CONV, clock, repos, notifier };
    expect(createToolExecutor(TOOL_REGISTRY, ctx).definitions.map((d) => d.name)).toContain(
      "escalate_to_human",
    );
    const out = outputOf(await run(MARIA, INPUT, { registry: TOOL_REGISTRY }));
    expect(out).toMatchObject({ phone: CLINIC.phone, hours: CLINIC.hours, already_escalated: false });
    expect(notifier.sent).toHaveLength(1);
  });

  it("records the escalation, notifies staff once, and returns the phone and hours", async () => {
    const out = outputOf(await run(MARIA));
    expect(out).toEqual({
      escalation_id: out.escalation_id,
      phone: CLINIC.phone,
      hours: CLINIC.hours,
      already_escalated: false,
    });

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toEqual({
      escalationId: out.escalation_id,
      conversationId: CONV,
      patient: { firstName: "Maria", lastName: "Santos", dateOfBirth: "1988-04-17" },
      reason: "patient_requested",
      summary: INPUT.summary,
      createdAt: clock.now().toISOString(),
      createdLocal: "Monday, October 5, 2026 at 9:00 AM ET",
      transcript: [
        {
          role: "patient",
          text: "I need to talk to someone about my bill.",
          createdAt: clock.now().toISOString(),
        },
        { role: "assistant", text: "Let me check your profile first.", createdAt: clock.now().toISOString() },
        {
          role: "assistant",
          text: "Billing is handled by our front desk.\nI can connect you with them.",
          createdAt: clock.now().toISOString(),
        },
      ],
    });

    const stored = await repos.escalations.getForConversation(MARIA, CONV);
    expect(stored).toMatchObject({
      escalationId: out.escalation_id,
      patientId: MARIA,
      reason: "patient_requested",
      summary: INPUT.summary,
      notification: { status: "SENT", messageId: "recorded-1" },
    });
  });

  it("never puts reasoning, tool calls, or tool results in the staff notice", async () => {
    await run(MARIA);
    const sent = JSON.stringify(notifier.sent);
    expect(sent).not.toMatch(/SECRET_/);
  });

  it("answers a repeat call with already_escalated and no second notification", async () => {
    const first = outputOf(await run(MARIA));
    const second = outputOf(
      await run(MARIA, { reason: "frustration", summary: "Patient is still upset and wants a call back." }),
    );
    expect(second).toEqual({ ...first, already_escalated: true });
    expect(notifier.sent).toHaveLength(1);
    // The original record is kept unchanged.
    expect(await repos.escalations.getForConversation(MARIA, CONV)).toMatchObject({
      reason: "patient_requested",
      summary: INPUT.summary,
    });
  });

  it("escalates exactly once under parallel calls", async () => {
    const results = (await Promise.all(Array.from({ length: 5 }, () => run(MARIA)))).map(outputOf);
    expect(results.filter((r) => !r.already_escalated)).toHaveLength(1);
    expect(new Set(results.map((r) => r.escalation_id)).size).toBe(1);
    expect(notifier.sent).toHaveLength(1);
    expect(repos.snapshot().escalations).toHaveLength(1);
  });

  it("still records the escalation and returns the phone and hours when no notifier is configured", async () => {
    const out = outputOf(await run(MARIA, INPUT, { notifier: null }));
    expect(out).toMatchObject({ phone: CLINIC.phone, hours: CLINIC.hours, already_escalated: false });
    expect(await repos.escalations.getForConversation(MARIA, CONV)).toMatchObject({
      notification: { status: "FAILED", error: "No notifier configured" },
    });
  });

  it("still records the escalation and returns the phone and hours when the notifier throws", async () => {
    notifier.failWith(new Error("SES throttled"));
    const out = outputOf(await run(MARIA));
    expect(out).toMatchObject({ phone: CLINIC.phone, hours: CLINIC.hours, already_escalated: false });
    const stored = await repos.escalations.getForConversation(MARIA, CONV);
    expect(stored?.notification).toEqual({ status: "FAILED", error: "Error: SES throttled" });

    // A retry after a failed send does not re-notify (at most once per conversation, FR-034).
    notifier.failWith(undefined);
    expect(outputOf(await run(MARIA)).already_escalated).toBe(true);
    expect(notifier.sent).toHaveLength(0);
  });

  it("clips a long notifier error to 500 characters", async () => {
    notifier.failWith(new Error("x".repeat(1000)));
    outputOf(await run(MARIA));
    const stored = await repos.escalations.getForConversation(MARIA, CONV);
    expect(stored?.notification).toEqual({ status: "FAILED", error: `Error: ${"x".repeat(493)}` });
  });

  it("records FAILED and still returns the phone and hours when building the notice fails", async () => {
    const failing: Repositories = {
      ...repos,
      patients: { ...repos.patients, get: () => Promise.reject(new Error("profile read failed")) },
    };
    const out = outputOf(await run(MARIA, INPUT, { repos: failing }));
    expect(out).toMatchObject({ phone: CLINIC.phone, hours: CLINIC.hours, already_escalated: false });
    expect(notifier.sent).toHaveLength(0);
    expect((await repos.escalations.getForConversation(MARIA, CONV))?.notification).toEqual({
      status: "FAILED",
      error: "Error: profile read failed",
    });
  });

  it("still returns the phone and hours when saving the delivery status fails", async () => {
    const failing: Repositories = {
      ...repos,
      escalations: {
        ...repos.escalations,
        updateNotification: () => Promise.reject(new Error("table unavailable")),
      },
    };
    const out = outputOf(await run(MARIA, INPUT, { repos: failing }));
    expect(out).toMatchObject({ phone: CLINIC.phone, already_escalated: false });
    expect(notifier.sent).toHaveLength(1);
    // The record stays PENDING, which operators can see.
    expect((await repos.escalations.getForConversation(MARIA, CONV))?.notification).toEqual({
      status: "PENDING",
    });
  });

  it("sends a notice without a name when the patient has no profile", async () => {
    outputOf(await run(UNKNOWN, INPUT, { conversationId: OTHER_CONV }));
    expect(notifier.sent[0]).toMatchObject({ patient: null, transcript: [] });
  });

  it("rejects invalid input and records nothing", async () => {
    const before = repos.snapshot();
    expect(errorOf(await run(MARIA, { reason: "billing", summary: INPUT.summary })).code).toBe(
      "INVALID_INPUT",
    );
    expect(errorOf(await run(MARIA, { reason: "frustration", summary: "short" })).code).toBe("INVALID_INPUT");
    expect(repos.snapshot()).toEqual(before);
    expect(notifier.sent).toHaveLength(0);
  });

  describe("cross-patient attempts", () => {
    it("rejects a model-supplied patient_id", async () => {
      const before = repos.snapshot();
      expect(errorOf(await run(WALTER, { ...INPUT, patient_id: MARIA })).code).toBe("INVALID_INPUT");
      expect(repos.snapshot()).toEqual(before);
    });

    it("can't piggyback on another patient's escalated conversation, and still gets the phone number", async () => {
      outputOf(await run(MARIA));
      const before = repos.snapshot();

      const error = errorOf(await run(WALTER));
      expect(error.code).toBe("NOT_FOUND");
      expect(error.hint).toContain(CLINIC.phone);
      expect(JSON.stringify(error)).not.toMatch(/Maria|escalat.*exists|belongs/i);
      expect(repos.snapshot()).toEqual(before);
      expect(notifier.sent).toHaveLength(1);
    });

    it("never sends another patient's messages to staff", async () => {
      // Walter's context names Maria's (not yet escalated) conversation id: the transcript reads as empty.
      outputOf(await run(WALTER));
      expect(notifier.sent[0]).toMatchObject({
        patient: { firstName: "Walter", lastName: "Haines", dateOfBirth: "1955-02-11" },
        transcript: [],
      });
      expect(JSON.stringify(notifier.sent)).not.toMatch(/about my bill|Maria/);
    });
  });

  describe("keeps IDs out of the summary (#107)", () => {
    const X = ID_PLACEHOLDER;
    const summaryOf = async (summary: string) => {
      const out = outputOf(await run(MARIA, { reason: "patient_requested", summary }));
      expect(out).toMatchObject({ phone: CLINIC.phone, hours: CLINIC.hours, already_escalated: false });
      const stored = await repos.escalations.getForConversation(MARIA, CONV);
      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0]?.summary).toBe(stored?.summary);
      return stored?.summary;
    };

    it("replaces every ID-shaped token in the stored escalation and the staff notice", async () => {
      expect(
        await summaryOf(
          `Patient asked to cancel ${UNKNOWN.toUpperCase()} (appt_01J9Z8Q7RS3TUV, slot_lee_20261013T1830Z) ` +
            "with prov_lee for pat-Walter; see esc_ABC_123.",
        ),
      ).toBe(`Patient asked to cancel ${X} (${X}, ${X}) with ${X} for ${X}; see ${X}.`);
    });

    it.each([
      ["a GUID", `Act on ${UNKNOWN} now`, `Act on ${X} now`],
      ["a GUID, upper case", `Act on ${UNKNOWN.toUpperCase()} now`, `Act on ${X} now`],
      ["a GUID glued to a letter before it", `Act on x${UNKNOWN} now`, `Act on x${X} now`],
      ["a GUID glued to a letter after it", `Act on ${UNKNOWN}x now`, `Act on ${X}x now`],
      [
        "a GUID glued to a word ending in a hex letter before it",
        `Act on uuid${UNKNOWN} now`,
        `Act on uuid${X} now`,
      ],
      ["a GUID glued to hex letters after it", `Act on ${UNKNOWN}abc now`, `Act on ${X}abc now`],
      ["a GUID glued to an underscore before it", `Act on patient_${UNKNOWN} now`, `Act on patient_${X} now`],
      ["a GUID glued to an underscore after it", `Act on ${UNKNOWN}_x now`, `Act on ${X}_x now`],
      ["a GUID glued to hyphens", `Act on 1234-${UNKNOWN}-x now`, `Act on 1234-${X}-x now`],
      ["a GUID inside an appointment prefix", `Cancel appt_${UNKNOWN} please`, `Cancel appt_${X} please`],
      ["an appointment ID, typed short", "Cancel appt_123 please", `Cancel ${X} please`],
      ["an appointment ID, any case", "Cancel APPT_123 please", `Cancel ${X} please`],
      ["a slot ID", "Wants slot_lee_20261013T1830Z", `Wants ${X}`],
      ["a provider ID", "Asked about prov_lee today", `Asked about ${X} today`],
      ["an escalation ID", "Earlier ticket esc_01J9Z8Q7RS was closed", `Earlier ticket ${X} was closed`],
      ["a fixture alias", "Booking for pat-walter, not me", `Booking for ${X}, not me`],
      ["a fixture alias, any case", "Booking for PAT-Walter, not me", `Booking for ${X}, not me`],
    ])("replaces %s", async (_name, summary, expected) => {
      expect(await summaryOf(summary)).toBe(expected);
    });

    it("replaces every occurrence, not just the first", async () => {
      expect(await summaryOf(`${UNKNOWN} ${MARIA} pat-maria pat-walter appt_1 slot_2`)).toBe(
        `${X} ${X} ${X} ${X} ${X} ${X}`,
      );
    });

    it("leaves text that only looks like an ID alone", async () => {
      const summary =
        "Patient asked about appt_ times, slots, my_appt_1, pat-walter2, a spat-like call, and " +
        `0${UNKNOWN} or ${UNKNOWN}0 after the patient's appointment.`;
      expect(await summaryOf(summary)).toBe(summary);
    });

    it("keeps a summary that was only an ID above the minimum length", async () => {
      expect(await summaryOf("appt_12345")).toBe(X);
    });

    it("caps a summary that grew past the maximum length", async () => {
      const summary = "esc_1 ".repeat(166); // 996 characters, each ID grows to the placeholder
      expect(await summaryOf(summary)).toBe(`${X} `.repeat(166).slice(0, 1000).trim());
    });
  });
});
