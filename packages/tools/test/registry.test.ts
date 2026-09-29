/**
 * The executor side of the agent/tools seam, exercised with dummy handlers registered only here
 * (the production TOOL_REGISTRY stays empty until #19–#23 land).
 */
import { TOOL_NAMES, ToolError, toolDefinitionsForModel, type PatientId } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../fixtures";
import { FrozenClock } from "../src/clock";
import { sequentialIds } from "../src/repos/ids";
import { createInMemoryRepositories } from "../src/repos/in-memory";
import { TOOL_ERROR_CODE_FOR, type Repositories } from "../src/repos/types";
import {
  createToolExecutor,
  toolFail,
  toolOk,
  TOOL_REGISTRY,
  type ToolContext,
  type ToolExecutionResult,
  type ToolHandler,
  type ToolRegistry,
} from "../src/registry";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const CONVERSATION = EXAMPLES.ConversationId;

/** A realistic dummy: reads the profile of whoever the context says is logged in. */
const getPatientProfile: ToolHandler<"get_patient_profile"> = async (_input, ctx) => {
  const patient = await ctx.repos.patients.get(ctx.patientId);
  if (!patient) return toolFail("NOT_FOUND", "No profile on file.");
  const preferred = patient.preferredProviderId
    ? await ctx.repos.providers.get(patient.preferredProviderId)
    : null;
  return toolOk({
    first_name: patient.firstName,
    last_name: patient.lastName,
    preferred_provider: preferred && {
      provider_id: preferred.providerId,
      display_name: preferred.displayName,
      specialty: preferred.specialty,
      accepting_new_patients: preferred.acceptingNewPatients,
    },
  });
};

/** A dummy that maps the repository's typed booking failures onto ToolErrors. */
const bookAppointment: ToolHandler<"book_appointment"> = async (input, ctx) => {
  const result = await ctx.repos.appointments.book({
    patientId: ctx.patientId,
    slotId: input.slot_id,
    reason: input.reason,
  });
  if (!result.ok)
    return toolFail(TOOL_ERROR_CODE_FOR[result.reason], "That time can't be booked.", "Offer other times.");
  const a = result.appointment;
  return toolOk({
    appointment: {
      appointment_id: a.appointmentId,
      provider_id: a.providerId,
      provider_name: "Dr. Priya Lee",
      specialty: a.specialty,
      start_utc: a.startUtc,
      start_local: "Tuesday, October 13, 2026 at 2:00 PM ET",
      status: a.status,
      reason: a.reason,
    },
    already_booked: result.alreadyBooked,
  });
};

function errorOf(result: ToolExecutionResult): ToolError["error"] {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.output)}`);
  return ToolError.parse(result.error).error;
}

describe("tool executor", () => {
  let repos: Repositories;
  let ctx: ToolContext;

  beforeEach(() => {
    const clock = new FrozenClock("2026-10-05T13:00:00Z");
    repos = createInMemoryRepositories({ seed: buildClinicFixture(), clock, ids: sequentialIds() });
    ctx = { patientId: MARIA, conversationId: CONVERSATION, clock, repos };
  });

  describe("definitions", () => {
    it("offers only registered tools, in the stable contracts order", () => {
      const executor = createToolExecutor(
        { book_appointment: bookAppointment, get_patient_profile: getPatientProfile },
        ctx,
      );
      expect(executor.definitions.map((d) => d.name)).toEqual(["get_patient_profile", "book_appointment"]);
      const expected = toolDefinitionsForModel().filter(
        (d) => d.name === "get_patient_profile" || d.name === "book_appointment",
      );
      expect(executor.definitions).toEqual(expected);
    });

    it("equals toolDefinitionsForModel() byte-for-byte once every tool is registered", () => {
      const all = Object.fromEntries(
        TOOL_NAMES.map((n) => [n, async () => toolFail("INTERNAL", "stub")]),
      ) as ToolRegistry;
      expect(JSON.stringify(createToolExecutor(all, ctx).definitions)).toBe(
        JSON.stringify(toolDefinitionsForModel()),
      );
    });

    it("is empty for the (still empty) production registry, whose keys are all tool names", () => {
      expect(Object.keys(TOOL_REGISTRY).every((k) => (TOOL_NAMES as readonly string[]).includes(k))).toBe(
        true,
      );
      expect(createToolExecutor(TOOL_REGISTRY, ctx).definitions.length).toBe(
        Object.keys(TOOL_REGISTRY).length,
      );
    });

    it("is frozen", () => {
      const executor = createToolExecutor({ get_patient_profile: getPatientProfile }, ctx);
      expect(Object.isFrozen(executor.definitions)).toBe(true);
    });
  });

  describe("execute", () => {
    it("runs a registered handler with the context's patient and returns validated output", async () => {
      const executor = createToolExecutor({ get_patient_profile: getPatientProfile }, ctx);
      const result = await executor.execute({ id: "toolu_01", name: "get_patient_profile", input: {} });
      expect(result).toEqual({
        ok: true,
        output: {
          first_name: "Maria",
          last_name: "Santos",
          preferred_provider: {
            provider_id: "prov_lee",
            display_name: "Dr. Priya Lee",
            specialty: "dermatology",
            accepting_new_patients: true,
          },
        },
      });
    });

    it("binds identity from the context only: a smuggled patient_id is INVALID_INPUT and the handler never runs", async () => {
      const handler = vi.fn(getPatientProfile);
      const executor = createToolExecutor({ get_patient_profile: handler }, ctx);
      const walter = FIXTURE_PATIENT_IDS["pat-walter"];
      const error = errorOf(
        await executor.execute({ id: "t", name: "get_patient_profile", input: { patient_id: walter } }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(/patient_id/);
      expect(handler).not.toHaveBeenCalled();
    });

    it("gives handlers a frozen context that can't be re-pointed at another patient", async () => {
      let seen: ToolContext | undefined;
      const executor = createToolExecutor(
        {
          get_patient_profile: async (input, c) => {
            seen = c;
            return getPatientProfile(input, c);
          },
        },
        ctx,
      );
      await executor.execute({ id: "t", name: "get_patient_profile", input: {} });
      expect(Object.isFrozen(seen)).toBe(true);
      expect(() => {
        (seen as { patientId: PatientId }).patientId = FIXTURE_PATIENT_IDS["pat-walter"];
      }).toThrow(TypeError);
    });

    it("passes the parsed input (defaults applied) to the handler", async () => {
      const handler = vi.fn<ToolHandler<"check_availability">>(async () =>
        toolOk({ slots: [], truncated: false }),
      );
      const executor = createToolExecutor({ check_availability: handler }, ctx);
      await executor.execute({
        id: "t",
        name: "check_availability",
        input: { specialty: "dermatology", date_range: { start_date: "2026-10-13", end_date: "2026-10-13" } },
      });
      expect(handler).toHaveBeenCalledWith(
        {
          specialty: "dermatology",
          date_range: { start_date: "2026-10-13", end_date: "2026-10-13" },
          time_of_day: "any",
        },
        expect.anything(),
      );
    });

    it.each([
      ["an unknown tool", "delete_everything"],
      ["a known tool that isn't registered", "reschedule_appointment"],
      ["a prototype key", "constructor"],
      ["another prototype key", "__proto__"],
    ])("returns NOT_FOUND for %s", async (_label, name) => {
      const executor = createToolExecutor({ get_patient_profile: getPatientProfile }, ctx);
      expect(errorOf(await executor.execute({ id: "t", name, input: {} })).code).toBe("NOT_FOUND");
    });

    it("clips an absurd tool name in the error message", async () => {
      const executor = createToolExecutor({}, ctx);
      const error = errorOf(await executor.execute({ id: "t", name: "x".repeat(5000), input: {} }));
      expect(error.message.length).toBeLessThanOrEqual(300);
    });

    it("reports every invalid field, within the ToolError length limit", async () => {
      const executor = createToolExecutor({ book_appointment: bookAppointment }, ctx);
      const error = errorOf(
        await executor.execute({
          id: "t",
          name: "book_appointment",
          input: { slot_id: "tuesday", reason: "" },
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(/slot_id/);
      expect(error.message).toMatch(/reason/);
      expect(
        errorOf(await executor.execute({ id: "t", name: "book_appointment", input: "not an object" })).code,
      ).toBe("INVALID_INPUT");
    });

    it("passes a handler's ToolError through (repository conflict → SLOT_UNAVAILABLE)", async () => {
      const executor = createToolExecutor({ book_appointment: bookAppointment }, ctx);
      // Maria's own slot is idempotent; Dr. Haddad's Thursday 10 AM is Walter's.
      const mine = await executor.execute({
        id: "t1",
        name: "book_appointment",
        input: { slot_id: "slot_lee_20261013T1830Z", reason: "Mole check" },
      });
      expect(mine).toMatchObject({ ok: true, output: { already_booked: true } });
      const taken = await executor.execute({
        id: "t2",
        name: "book_appointment",
        input: { slot_id: "slot_haddad_20261015T1400Z", reason: "Checkup" },
      });
      expect(errorOf(taken)).toEqual({
        code: "SLOT_UNAVAILABLE",
        message: "That time can't be booked.",
        hint: "Offer other times.",
      });
    });

    it("turns a thrown error into INTERNAL without leaking it, and reports the cause", async () => {
      const onInternalError = vi.fn();
      const executor = createToolExecutor(
        {
          get_patient_profile: async () => {
            throw new Error("ConditionalCheckFailed on arn:aws:dynamodb:table/secret-name");
          },
        },
        ctx,
        { onInternalError },
      );
      const result = await executor.execute({ id: "toolu_9", name: "get_patient_profile", input: {} });
      const error = errorOf(result);
      expect(error.code).toBe("INTERNAL");
      expect(JSON.stringify(result)).not.toMatch(/arn|dynamodb|secret/i);
      expect(onInternalError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ id: "toolu_9" }),
      );
    });

    it("turns output that breaks the contract into INTERNAL", async () => {
      const onInternalError = vi.fn();
      const bad = (async () => ({
        ok: true,
        output: { first_name: "Maria", patient_id: MARIA },
      })) as unknown as ToolHandler<"get_patient_profile">;
      const executor = createToolExecutor({ get_patient_profile: bad }, ctx, { onInternalError });
      const result = await executor.execute({ id: "t", name: "get_patient_profile", input: {} });
      expect(errorOf(result).code).toBe("INTERNAL");
      expect(JSON.stringify(result)).not.toContain(MARIA);
      expect(String(onInternalError.mock.calls[0]?.[0])).toMatch(/invalid output/);
    });

    it("turns a malformed ToolError from a handler into INTERNAL", async () => {
      const bad = (async () => ({
        ok: false,
        error: { error: { code: "OOPS", message: "" } },
      })) as unknown as ToolHandler<"get_patient_profile">;
      const executor = createToolExecutor({ get_patient_profile: bad }, ctx);
      expect(errorOf(await executor.execute({ id: "t", name: "get_patient_profile", input: {} })).code).toBe(
        "INTERNAL",
      );
    });

    it("never throws, even if the error hook does", async () => {
      const executor = createToolExecutor(
        {
          get_patient_profile: async () => {
            throw new Error("boom");
          },
        },
        ctx,
        {
          onInternalError: () => {
            throw new Error("logger down");
          },
        },
      );
      expect(errorOf(await executor.execute({ id: "t", name: "get_patient_profile", input: {} })).code).toBe(
        "INTERNAL",
      );
    });

    it("runs parallel calls independently (the loop executes tool_use blocks concurrently)", async () => {
      const executor = createToolExecutor(
        { book_appointment: bookAppointment, get_patient_profile: getPatientProfile },
        ctx,
      );
      const results = await Promise.all([
        executor.execute({ id: "a", name: "get_patient_profile", input: {} }),
        executor.execute({
          id: "b",
          name: "book_appointment",
          input: { slot_id: "slot_lee_20261013T1800Z", reason: "Skin check" },
        }),
        executor.execute({
          id: "c",
          name: "book_appointment",
          input: { slot_id: "slot_lee_20261013T1800Z", reason: "Skin check" },
        }),
        executor.execute({ id: "d", name: "nope", input: {} }),
      ]);
      expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
      expect(
        results.filter((r) => r.ok && (r.output as { already_booked?: boolean }).already_booked === true),
      ).toHaveLength(1);
    });
  });

  it("refuses to build an executor without a valid patient identity", () => {
    expect(() => createToolExecutor({}, { ...ctx, patientId: "" })).toThrow();
    expect(() => createToolExecutor({}, { ...ctx, conversationId: "abc" })).toThrow();
  });
});
