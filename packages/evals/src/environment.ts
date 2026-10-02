/**
 * One isolated world per trial (ADR-008): in-memory repositories seeded from the scenario's fixture plus
 * its `setup` overrides, a FrozenClock at the scenario's `clock`, sequential ids, and a tool executor
 * bound to the scenario's patient (the JWT stand-in, CLAUDE.md rule 1) with fault injection applied, and a
 * `RecordingNotifier` for staff emails. Nothing is shared between trials.
 */
import {
  Appointment,
  type ConversationId,
  type ConversationMessage,
  type PatientId,
  type Slot,
  type ToolErrorCode,
  type ToolName,
} from "@sched/contracts";
import {
  createInMemoryRepositories,
  createToolExecutor,
  FrozenClock,
  sequentialIds,
  toolFail,
  TOOL_REGISTRY,
  type InMemoryRepositories,
  type InMemorySnapshot,
  type ToolContext,
  type ToolExecutor,
  type ToolHandler,
  type ToolRegistry,
  RecordingNotifier,
} from "@sched/tools";
import { FIXTURE_PATIENT_IDS, FIXTURES, type ClinicFixture } from "@sched/tools/fixtures";

import type { L1Case, Scenario, Setup, SetupFault } from "./schema";
import { targetSlotOf } from "./transcript";

export interface TrialEnvironment {
  patientId: PatientId;
  conversationId: ConversationId;
  clock: FrozenClock;
  repos: InMemoryRepositories;
  executor: ToolExecutor;
  /** State right after seeding, before the agent runs. */
  before: InMemorySnapshot;
  /** Every fault that fired, in order. */
  faultsFired: FiredFault[];
  /** Staff notices `escalate_to_human` sent this trial (`failWith` makes delivery fail). */
  notifier: RecordingNotifier;
  /** Makes deterministic UUIDs (conversation and turn ids). */
  uuid: () => string;
}

export interface FiredFault {
  tool: ToolName;
  call: number;
  error: ToolErrorCode;
  /** The slot another patient took (`slot_taken_by_other_patient`), and the appointment that took it. */
  takenSlotId?: string;
  takenAppointmentId?: string;
}

export interface EnvironmentOptions {
  /** Tool handlers. Default: the production `TOOL_REGISTRY` (tests pass their own). */
  registry?: ToolRegistry;
}

/** Deterministic v4-shaped UUIDs: `00000000-0000-4000-8000-<12-digit n>`, one counter per trial. */
export function uuidSequence(prefix = 0): () => string {
  let n = 0;
  return () => {
    n += 1;
    const block = String(prefix).padStart(8, "0").slice(-8);
    return `${block}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/** Apply `setup.appointments` to the seed: each slot becomes BOOKED by a new BOOKED appointment. */
function seedWithSetup(fixture: ClinicFixture, setup: Setup | undefined, createdAt: string): ClinicFixture {
  const extra = setup?.appointments ?? [];
  if (extra.length === 0) return fixture;
  const slots = new Map<string, Slot>(fixture.slots.map((s) => [s.slotId, { ...s }]));
  const appointments = [...fixture.appointments];
  for (const a of extra) {
    const slot = slots.get(a.slot_id);
    if (slot === undefined || slot.status !== "OPEN")
      throw new Error(`setup.appointments: ${a.slot_id} is not an OPEN slot in the fixture`);
    slots.set(a.slot_id, { ...slot, status: "BOOKED", appointmentId: a.appointment_id });
    appointments.push(
      Appointment.parse({
        appointmentId: a.appointment_id,
        patientId: FIXTURE_PATIENT_IDS[a.patient],
        providerId: slot.providerId,
        slotId: slot.slotId,
        specialty: slot.specialty,
        startUtc: slot.startUtc,
        endUtc: slot.endUtc,
        status: "BOOKED",
        reason: a.reason,
        createdAt,
        updatedAt: createdAt,
      }),
    );
  }
  return { ...fixture, slots: [...slots.values()], appointments };
}

/**
 * Error text for faults with no real cause in the world (an `INTERNAL` outage, say). A
 * `slot_taken_by_other_patient` fault makes the cause real instead, so the production handler answers
 * with its own message and hint.
 */
const FAULT_MESSAGES: Record<ToolErrorCode, [string, string]> = {
  SLOT_UNAVAILABLE: [
    "That time is no longer available.",
    "Apologize and offer other options from check_availability.",
  ],
  INTERNAL: [
    "The tool failed unexpectedly.",
    "Try once more. If it fails again, apologize and offer to connect the patient with the front desk.",
  ],
  NOT_FOUND: ["Not found.", "Check the id and try again."],
  NOT_ALLOWED: ["That action is not allowed.", "Explain what you can do instead."],
  INVALID_INPUT: ["Invalid input.", "Fix the input and call the tool again."],
};

/**
 * Wrap registered handlers so the configured calls fail with the configured error. Calls are counted per
 * tool when they reach the handler (valid input). `slot_taken_by_other_patient` books the requested slot
 * for another fixture patient first, so later reads agree that it's gone, then lets the real handler run:
 * it finds the slot taken and answers with production's own error text.
 */
export function withFaults(
  registry: ToolRegistry,
  faults: readonly SetupFault[],
  options: { otherPatientId: PatientId; fired: FiredFault[] },
): ToolRegistry {
  if (faults.length === 0) return registry;
  const wrapped: Record<string, unknown> = { ...registry };
  const counts = new Map<ToolName, number>();
  for (const tool of new Set(faults.map((f) => f.tool))) {
    const handler = registry[tool] as ToolHandler<ToolName> | undefined;
    if (handler === undefined) continue; // not offered, so it can't be called
    const forTool = faults.filter((f) => f.tool === tool);
    const faulty = async (input: never, ctx: ToolContext) => {
      const n = (counts.get(tool) ?? 0) + 1;
      counts.set(tool, n);
      const fault = forTool.find((f) => f.call === "all" || f.call === n);
      if (fault === undefined) return handler(input, ctx);
      const fired: FiredFault = { tool, call: n, error: fault.error };
      if (fault.effect === "slot_taken_by_other_patient") {
        const slotId = targetSlotOf(tool, input);
        if (slotId !== undefined) {
          const result = await ctx.repos.appointments.book({
            patientId: options.otherPatientId,
            slotId,
            reason: "Booked by another patient (eval fault injection)",
          });
          if (result.ok) {
            fired.takenSlotId = slotId;
            fired.takenAppointmentId = result.appointment.appointmentId;
            options.fired.push(fired);
            return handler(input, ctx);
          }
        }
        // The slot wasn't open to take: the real handler would answer something else, so fake the error.
      }
      options.fired.push(fired);
      const [message, hint] = FAULT_MESSAGES[fault.error];
      return toolFail(fault.error, message, hint);
    };
    wrapped[tool] = faulty;
  }
  return wrapped as ToolRegistry;
}

/** Build the isolated world for one trial of a scenario or L1 case. */
export async function createTrialEnvironment(
  scenario: Scenario | L1Case,
  options: EnvironmentOptions & { trial?: number } = {},
): Promise<TrialEnvironment> {
  const clock = new FrozenClock(scenario.clock);
  const uuid = uuidSequence(options.trial ?? 0);
  const fixture = seedWithSetup(
    FIXTURES[scenario.fixture](),
    scenario.setup,
    new Date(clock.now().getTime() - 86_400_000).toISOString(),
  );
  const repos = createInMemoryRepositories({ clock, ids: sequentialIds(), seed: fixture });

  // setup.conversations: another patient's pre-existing history (append-only, seq from 0).
  for (const conv of scenario.setup?.conversations ?? []) {
    const turnId = uuid();
    const owner = FIXTURE_PATIENT_IDS[conv.patient];
    const messages: ConversationMessage[] = conv.messages.map((m, seq) => ({
      conversationId: conv.conversation_id,
      seq,
      role: m.role === "patient" ? "user" : "assistant",
      content: [{ type: "text", text: m.text }],
      turnId,
      createdAt: new Date(clock.now().getTime() - 3_600_000 + seq * 1000).toISOString(),
    }));
    await repos.conversations.append(owner, messages);
  }

  const patientId = FIXTURE_PATIENT_IDS[scenario.patient];
  const conversationId = uuid();
  const otherPatientId = Object.values(FIXTURE_PATIENT_IDS).find((id) => id !== patientId) ?? patientId;
  const faultsFired: FiredFault[] = [];
  const registry = withFaults(options.registry ?? TOOL_REGISTRY, scenario.setup?.faults ?? [], {
    otherPatientId,
    fired: faultsFired,
  });
  const notifier = new RecordingNotifier();
  const executor = createToolExecutor(registry, { patientId, conversationId, clock, repos, notifier });

  return {
    patientId,
    conversationId,
    clock,
    repos,
    executor,
    before: repos.snapshot(),
    faultsFired,
    notifier,
    uuid,
  };
}
