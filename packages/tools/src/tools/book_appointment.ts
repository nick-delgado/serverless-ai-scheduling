/**
 * book_appointment (FR-031, FR-035, NFR-008): book an open slot for the logged-in patient.
 *
 * - Identity comes from ctx.patientId (the verified JWT), never from input (CLAUDE.md rule 1).
 * - The booking itself is one atomic repository call (`appointments.book`, AP-6, CLAUDE.md rule 2). The
 *   handler never decides availability from a read: the repo's conditional write is the check.
 * - Checks, in order (decisions, PR #69 review):
 *   1. Idempotent first (ADR-004, SPEC-1): if the patient already holds the slot, return that appointment
 *      with `already_booked: true`, even if it has started. The hold is read through the patient-scoped
 *      `appointments.get`, so another patient's booking reads as nothing.
 *   2. The slot must start after `ctx.clock.now()` (SPEC-3).
 *   3. A provider who isn't accepting new patients can be booked only by an existing patient: one with a
 *      COMPLETED or BOOKED appointment with that provider (SPEC-4). Read from the patient's own list.
 *   These reads only decide the answer; the repo's conditional write still decides availability, and it is
 *   idempotent too, for a retry that races this check.
 *
 * Error codes:
 * - unknown slot → NOT_FOUND;
 * - slot already started or in the past, or a new patient for a provider not accepting new patients →
 *   NOT_ALLOWED: the slot exists and the input is well-formed, but booking it is against the rules, and no
 *   retry of the same call can succeed;
 * - slot held by anyone else → SLOT_UNAVAILABLE (never says by whom).
 */
import { startsAfter } from "../clock";
import { toolFail, toolOk, type ToolHandler } from "../handler";
import { TOOL_ERROR_CODE_FOR } from "../repos/types";
import { toAppointmentSummary } from "./summaries";

const SLOT_NOT_FOUND = [
  "No open time with that slot_id exists.",
  "Call check_availability to get current slot_ids, then confirm the time with the patient before booking.",
] as const;

export const bookAppointment: ToolHandler<"book_appointment"> = async (input, ctx) => {
  // The slot's start time and provider (immutable) and its appointmentId, for the hold check below. No read
  // here decides availability: the atomic write does.
  const slot = await ctx.repos.slots.get(input.slot_id);
  if (!slot) return toolFail("NOT_FOUND", ...SLOT_NOT_FOUND);

  // The provider gives the display name and acceptingNewPatients. Resolve it before writing: a dangling
  // provider is a broken invariant (INTERNAL), and failing here means nothing was booked.
  const provider = await ctx.repos.providers.get(slot.providerId);
  if (!provider) throw new Error(`Slot ${slot.slotId} references unknown provider ${slot.providerId}`);

  if (slot.appointmentId !== undefined) {
    const held = await ctx.repos.appointments.get(ctx.patientId, slot.appointmentId);
    if (held?.status === "BOOKED") {
      return toolOk({ appointment: toAppointmentSummary(held, provider), already_booked: true });
    }
  }

  if (!startsAfter(slot.startUtc, ctx.clock.now())) {
    return toolFail(
      "NOT_ALLOWED",
      "That time has already passed, so it can't be booked.",
      "Tell the patient that time is no longer available, call check_availability for upcoming times, and offer those.",
    );
  }

  if (!provider.acceptingNewPatients) {
    const history = await ctx.repos.appointments.listForPatient(ctx.patientId);
    const established = history.some(
      (a) => a.providerId === provider.providerId && (a.status === "COMPLETED" || a.status === "BOOKED"),
    );
    if (!established) {
      return toolFail(
        "NOT_ALLOWED",
        "That provider isn't taking new patients, so this patient can't be booked with them.",
        "Tell the patient, then offer another provider in the same specialty: check_availability by specialty lists only providers taking new patients. Book only after the patient confirms.",
      );
    }
  }

  const result = await ctx.repos.appointments.book({
    patientId: ctx.patientId,
    slotId: input.slot_id,
    reason: input.reason,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "SLOT_NOT_FOUND":
        return toolFail(TOOL_ERROR_CODE_FOR.SLOT_NOT_FOUND, ...SLOT_NOT_FOUND);
      case "SLOT_UNAVAILABLE":
        return toolFail(
          TOOL_ERROR_CODE_FOR.SLOT_UNAVAILABLE,
          "That time was just taken and is no longer available.",
          "Apologize, call check_availability again for the same provider and day, and offer the nearest open times. Book only after the patient confirms one.",
        );
    }
  }

  return toolOk({
    appointment: toAppointmentSummary(result.appointment, provider),
    already_booked: result.alreadyBooked,
  });
};
