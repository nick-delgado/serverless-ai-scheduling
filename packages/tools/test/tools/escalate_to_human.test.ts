import { CLINIC, TOOLS, type ConversationMessage, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import {
  formatEscalationNotice,
  RecordingNotifier,
  type EscalationNotice,
  type Notifier,
} from "../../src/notify";
import { createToolExecutor, type ToolContext, type ToolExecutionResult } from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import type { Repositories } from "../../src/repos/types";
import { escalateToHuman } from "../../src/tools/escalate_to_human";

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
    content: [{ type: "text", text: "Billing is handled by our front desk." }],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
];

describe("escalate_to_human", () => {
  let repos: InMemoryRepositories;
  let clock: FrozenClock;
  let notifier: RecordingNotifier;

  const firstNotice = (): EscalationNotice => {
    const notice = notifier.sent[0];
    if (!notice) throw new Error("expected a notice");
    return notice;
  };

  const run = (
    patientId: string,
    input: unknown = INPUT,
    opts: { notifier?: Notifier | null; repos?: Repositories; conversationId?: string } = {},
  ): Promise<ToolExecutionResult> => {
    const n = opts.notifier === null ? undefined : (opts.notifier ?? notifier);
    const ctx: ToolContext = {
      patientId,
      conversationId: opts.conversationId ?? CONV,
      clock,
      repos: opts.repos ?? repos,
      ...(n ? { notifier: n } : {}),
    };
    return createToolExecutor({ escalate_to_human: escalateToHuman }, ctx).execute({
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
      patientFirstName: "Maria",
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
          text: "Billing is handled by our front desk.",
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
    expect(formatEscalationNotice(firstNotice()).body).not.toMatch(/SECRET_/);
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
  });

  it("sends a notice without a name when the patient has no profile", async () => {
    outputOf(await run(UNKNOWN, INPUT, { conversationId: OTHER_CONV }));
    expect(notifier.sent[0]).toMatchObject({ patientFirstName: null, transcript: [] });
    expect(formatEscalationNotice(firstNotice()).subject).toBe(
      "Escalation: Patient asked for a person (a patient)",
    );
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
      expect(notifier.sent[0]).toMatchObject({ patientFirstName: "Walter", transcript: [] });
      expect(JSON.stringify(notifier.sent)).not.toMatch(/about my bill|Maria/);
    });
  });
});
