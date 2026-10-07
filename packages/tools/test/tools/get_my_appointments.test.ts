import { TOOLS, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS, type ClinicFixture } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import {
  createToolExecutor,
  TOOL_REGISTRY,
  type ToolContext,
  type ToolExecutionResult,
  type ToolExecutorOptions,
} from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import { isUpcoming } from "../../src/index";
import { getMyAppointments } from "../../src/tools/get_my_appointments";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const DANIEL = FIXTURE_PATIENT_IDS["pat-daniel"];
const AISHA = FIXTURE_PATIENT_IDS["pat-aisha"]; // no appointments
const UNKNOWN = "0b3c5d7e-1f2a-4b6c-8d9e-0a1b2c3d4e5f"; // valid v4 UUID, not in the fixture

const MARIA_APPT = "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY"; // Tue Oct 13, 2:30 PM EDT, Dr. Lee
const WALTER_UPCOMING = "appt_01JBX8C4D5E6F7G8H9J0K1M2N3"; // Thu Oct 15, 10:00 AM EDT, BOOKED
const WALTER_PAST = "appt_01J9Z2P3Q4R5S6T7V8W9X0Y1Z2"; // Mon Sep 14, 9:00 AM EDT, COMPLETED
const DANIEL_BOOKED = "appt_01JBX9D5E6F7G8H9J0K1M2N3P4"; // Wed Oct 7, 4:00 PM EDT
const DANIEL_CANCELLED = "appt_01JBXA0E6F7G8H9J0K1M2N3P4Q"; // Fri Oct 9, 9:00 AM EDT

type Output = ToolOutput<"get_my_appointments">;

const outputOf = (r: ToolExecutionResult): Output => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return TOOLS.get_my_appointments.output.parse(r.output);
};
const errorOf = (r: ToolExecutionResult): ToolError["error"] => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error.error;
};
const idsOf = (o: Output): string[] => o.appointments.map((a) => a.appointment_id);

describe("get_my_appointments", () => {
  let fixture: ClinicFixture;
  let repos: InMemoryRepositories;
  let clock: FrozenClock;

  const contextFor = (patientId: string): ToolContext => ({
    patientId,
    conversationId: EXAMPLES.ConversationId,
    clock,
    repos,
  });
  // Through the executor, so the strict input schema and output validation the model faces apply.
  const run = (
    patientId: string,
    input: unknown = {},
    options: ToolExecutorOptions = {},
  ): Promise<ToolExecutionResult> =>
    createToolExecutor({ get_my_appointments: getMyAppointments }, contextFor(patientId), options).execute({
      id: "toolu_test",
      name: "get_my_appointments",
      input,
    });

  beforeEach(() => {
    fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow); // Mon Oct 5, 2026, 9:00 AM EDT
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("is registered in TOOL_REGISTRY, so the model is offered it and calls reach this handler", async () => {
    const executor = createToolExecutor(TOOL_REGISTRY, contextFor(MARIA));
    expect(executor.definitions.map((d) => d.name)).toContain("get_my_appointments");
    const result = await executor.execute({ id: "toolu_test", name: "get_my_appointments", input: {} });
    expect(idsOf(outputOf(result))).toEqual([MARIA_APPT]);
  });

  it("returns the logged-in patient's upcoming appointment with a clinic-local time", async () => {
    expect(outputOf(await run(MARIA))).toEqual({
      appointments: [
        {
          appointment_id: MARIA_APPT,
          provider_id: "prov_lee",
          provider_name: "Dr. Priya Lee",
          specialty: "dermatology",
          start_utc: "2026-10-13T18:30:00Z",
          start_local: "Tuesday, October 13, 2026 at 2:30 PM ET",
          status: "BOOKED",
          reason: "Mole check",
        },
      ],
    });
  });

  it("returns upcoming only by default, and past too with include_past, sorted by start", async () => {
    expect(idsOf(outputOf(await run(WALTER)))).toEqual([WALTER_UPCOMING]);
    expect(idsOf(outputOf(await run(WALTER, { include_past: false })))).toEqual([WALTER_UPCOMING]);

    const all = outputOf(await run(WALTER, { include_past: true }));
    expect(idsOf(all)).toEqual([WALTER_PAST, WALTER_UPCOMING]);
    expect(all.appointments[0]).toMatchObject({
      provider_id: "prov_brooks",
      status: "COMPLETED",
      start_local: "Monday, September 14, 2026 at 9:00 AM ET",
    });
    expect(all.appointments[1]).toMatchObject({
      provider_id: "prov_haddad",
      status: "BOOKED",
      start_local: "Thursday, October 15, 2026 at 10:00 AM ET",
    });
  });

  it("passes every status through, including an upcoming CANCELLED appointment", async () => {
    const out = outputOf(await run(DANIEL));
    expect(out.appointments.map((a) => [a.appointment_id, a.status])).toEqual([
      [DANIEL_BOOKED, "BOOKED"],
      [DANIEL_CANCELLED, "CANCELLED"],
    ]);
  });

  it("splits upcoming and past by ctx.clock, not the real clock", async () => {
    const start = "2026-10-13T18:30:00Z"; // Maria's appointment
    clock.set(start);
    expect(idsOf(outputOf(await run(MARIA)))).toEqual([MARIA_APPT]); // starts exactly now: still upcoming

    clock.advance(1);
    expect(outputOf(await run(MARIA))).toEqual({ appointments: [] });
    expect(idsOf(outputOf(await run(MARIA, { include_past: true })))).toEqual([MARIA_APPT]);
  });

  it("formats times on both sides of the Nov 1 DST change with the right weekday", async () => {
    // Fri Oct 30, 10:00 AM EDT (14:00Z) and Mon Nov 2, 10:00 AM EST (15:00Z): both 10:00 AM clinic time.
    for (const slotId of ["slot_lee_20261102T1500Z", "slot_lee_20261030T1400Z"]) {
      const booked = await repos.appointments.book({ patientId: MARIA, slotId, reason: "Follow-up" });
      expect(booked.ok).toBe(true);
    }

    const out = outputOf(await run(MARIA));
    expect(out.appointments.map((a) => [a.start_utc, a.start_local])).toEqual([
      ["2026-10-13T18:30:00Z", "Tuesday, October 13, 2026 at 2:30 PM ET"],
      ["2026-10-30T14:00:00Z", "Friday, October 30, 2026 at 10:00 AM ET"],
      ["2026-11-02T15:00:00Z", "Monday, November 2, 2026 at 10:00 AM ET"],
    ]);
  });

  it("returns an empty list (success, not NOT_FOUND) for a patient with no appointments", async () => {
    expect(outputOf(await run(AISHA, { include_past: true }))).toEqual({ appointments: [] });
    // A patient with no profile at all looks the same: nothing to reveal.
    expect(outputOf(await run(UNKNOWN, { include_past: true }))).toEqual({ appointments: [] });
  });

  it("reports INTERNAL rather than inventing a name when an appointment's provider record is missing", async () => {
    vi.spyOn(repos.providers, "get").mockResolvedValue(null);
    const causes: unknown[] = [];
    const result = await run(MARIA, {}, { onInternalError: (error) => causes.push(error) });
    expect(errorOf(result).code).toBe("INTERNAL");
    // The handler's own guard, not a TypeError from reading a null provider.
    expect(String(causes[0])).toMatch(/Appointment references unknown provider prov_lee/);
  });

  it("rejects invalid input", async () => {
    expect(errorOf(await run(MARIA, { include_past: "yes" })).code).toBe("INVALID_INPUT");
  });

  it("only ever returns the context patient's appointments (cross-patient attempt)", async () => {
    const before = repos.snapshot();

    // A model-supplied patient_id is rejected by the strict schema, never honoured...
    expect(errorOf(await run(MARIA, { patient_id: WALTER })).code).toBe("INVALID_INPUT");
    expect(errorOf(await run(MARIA, { include_past: true, patient_id: WALTER })).code).toBe("INVALID_INPUT");

    // ...and for every fixture patient, the result is exactly that patient's own appointments.
    for (const patientId of Object.values(FIXTURE_PATIENT_IDS)) {
      const own = fixture.appointments.filter((a) => a.patientId === patientId).map((a) => a.appointmentId);
      expect(idsOf(outputOf(await run(patientId, { include_past: true }))).sort()).toEqual(own.sort());
    }

    expect(repos.snapshot()).toEqual(before); // read-only
  });
});

describe("isUpcoming (shared with the session greeting, #125)", () => {
  const now = new Date("2026-10-13T18:30:00Z");

  it("counts an appointment starting exactly now as upcoming, and one a minute earlier as past", () => {
    expect(isUpcoming({ startUtc: "2026-10-13T18:30:00Z" }, now)).toBe(true);
    expect(isUpcoming({ startUtc: "2026-10-13T18:31:00Z" }, now)).toBe(true);
    expect(isUpcoming({ startUtc: "2026-10-13T18:29:00Z" }, now)).toBe(false);
  });
});
