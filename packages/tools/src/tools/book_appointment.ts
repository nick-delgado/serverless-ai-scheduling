/**
 * book_appointment (FR-031, FR-035, NFR-008): book an open slot for the logged-in patient.
 *
 * - Identity comes from ctx.patientId (the verified JWT), never from input (CLAUDE.md rule 1).
 * - The booking itself is one atomic repository call (`appointments.book`, AP-6, CLAUDE.md rule 2). The
 *   handler never decides availability from a read: the repo's conditional write is the check.
 * - The only reads before the write are of immutable facts (the slot's start time and provider), for the
 *   tool-level "not in the past" rule, which needs `ctx.clock`, and for the provider's display name.
 * - Idempotent (ADR-004): a retry by the patient who already holds the slot returns that appointment with
 *   `already_booked: true` instead of an error.
 *
 * Error codes:
 * - unknown slot → NOT_FOUND;
 * - slot already started or in the past (relative to ctx.clock) → NOT_ALLOWED: the slot exists and the input
 *   is well-formed, but booking it is against the rules, and no retry of the same call can succeed;
 * - slot held by anyone else → SLOT_UNAVAILABLE (never says by whom).
 */
import type { Appointment, AppointmentSummary, Provider } from "@sched/contracts";

import { formatClinicDateTime } from "../clock";
import { toolFail, toolOk, type ToolHandler } from "../registry";
import { TOOL_ERROR_CODE_FOR } from "../repos/types";

const toAppointmentSummary = (a: Appointment, provider: Provider): AppointmentSummary => ({
  appointment_id: a.appointmentId,
  provider_id: a.providerId,
  provider_name: provider.displayName,
  specialty: a.specialty,
  start_utc: a.startUtc,
  start_local: formatClinicDateTime(a.startUtc),
  status: a.status,
  reason: a.reason,
});

const SLOT_NOT_FOUND = [
  "No open time with that slot_id exists.",
  "Call check_availability to get current slot_ids, then confirm the time with the patient before booking.",
] as const;

export const bookAppointment: ToolHandler<"book_appointment"> = async (input, ctx) => {
  // Immutable facts about the slot (start time, provider): safe to read before the atomic write.
  const slot = await ctx.repos.slots.get(input.slot_id);
  if (!slot) return toolFail("NOT_FOUND", ...SLOT_NOT_FOUND);

  if (Date.parse(slot.startUtc) <= ctx.clock.now().getTime()) {
    return toolFail(
      "NOT_ALLOWED",
      "That time has already passed, so it can't be booked.",
      "Tell the patient that time is no longer available, call check_availability for upcoming times, and offer those.",
    );
  }

  // Resolve the display name before writing: a dangling provider is a broken invariant (INTERNAL), and
  // failing here means nothing was booked.
  const provider = await ctx.repos.providers.get(slot.providerId);
  if (!provider) throw new Error(`Slot ${slot.slotId} references unknown provider ${slot.providerId}`);

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
