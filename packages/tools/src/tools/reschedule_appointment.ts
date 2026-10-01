/**
 * reschedule_appointment (FR-032, NFR-008): move the logged-in patient's BOOKED appointment to another
 * open slot, all-or-nothing.
 *
 * - Identity comes from ctx.patientId (the verified JWT), never from input (CLAUDE.md rule 1). Another
 *   patient's appointment reads as "not found", with no hint that it exists.
 * - The move is one `appointments.reschedule` call (AP-7, one transaction): the old slot is released only
 *   if the new one is booked (CLAUDE.md rule 2). The reads before it only enforce the tool-level rules
 *   listed below; availability, status and ownership are decided by the repo's conditional write.
 * - Checks, in order:
 *   1. The appointment must be the patient's and BOOKED.
 *   2. A retry of a move that already happened (the appointment already holds the new slot) answers
 *      SAME_SLOT, whose hint says the move succeeded, before any clock rule: once the new time has started,
 *      "can't be moved" would tell the patient they lost an appointment they hold (PR #67 review, STD-3).
 *   3. Clock rules (tool-level, need ctx.clock): an appointment that has already started can't be moved,
 *      and the new slot must start after now.
 *   4. The new slot must be in the same specialty (owner decision, PR #67 review SPEC-2): a different kind
 *      of visit needs a new reason, which only book_appointment collects.
 *   5. Another provider is allowed, but a provider who isn't accepting new patients only for an existing
 *      patient: one with a COMPLETED or BOOKED appointment with that provider (the appointment being moved
 *      counts), the same rule as book_appointment (PR #67 review, SPEC-1).
 *   Rule breaks answer NOT_ALLOWED, as opposed to SLOT_UNAVAILABLE (someone else holds the slot), and the
 *   hint points the model at the next step. The returned summary names the new provider so the model can
 *   say so.
 */
import type { Appointment, AppointmentSummary, Provider } from "@sched/contracts";

import { formatClinicDateTime } from "../clock";
import { toolFail, toolOk, type ToolHandler, type ToolHandlerResult } from "../registry";
import { TOOL_ERROR_CODE_FOR, type RescheduleFailureReason } from "../repos/types";

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

const LIST_HINT =
  "Call get_my_appointments, ask the patient which appointment they mean, and use its appointment_id.";
const BOOK_NEW_HINT =
  "Tell the patient, and offer to book a new appointment instead (check_availability, then book_appointment).";
const AVAILABILITY_HINT =
  "Call check_availability, offer the patient one of the returned times, and use that slot_id after they confirm.";

/** Message and hint for each repository failure. The code comes from TOOL_ERROR_CODE_FOR. */
const FAILURE_TEXT: Record<RescheduleFailureReason, { message: string; hint: string }> = {
  APPOINTMENT_NOT_FOUND: {
    message: "No appointment with that ID was found for you. Nothing was changed.",
    hint: LIST_HINT,
  },
  APPOINTMENT_NOT_BOOKED: {
    message: "That appointment is cancelled or completed, so it can't be moved. Nothing was changed.",
    hint: BOOK_NEW_HINT,
  },
  SAME_SLOT: {
    message: "The appointment is already at that time. Nothing was changed.",
    hint: "If you just rescheduled it, the move already succeeded: confirm the time with the patient. Otherwise ask for a different time.",
  },
  SLOT_NOT_FOUND: {
    message: "That new time slot doesn't exist. The original appointment is unchanged.",
    hint: AVAILABILITY_HINT,
  },
  SLOT_UNAVAILABLE: {
    message: "That new time is no longer available. The original appointment is unchanged.",
    hint: "Call check_availability again and offer other times. Keep the original appointment unless the patient confirms a new one.",
  },
  CONFLICT: {
    message: "The appointment changed while it was being moved. Nothing was changed.",
    hint: "Call get_my_appointments to see its current time, then try once more only if the patient still wants the move.",
  },
};

const fail = (reason: RescheduleFailureReason): ToolHandlerResult<"reschedule_appointment"> =>
  toolFail(TOOL_ERROR_CODE_FOR[reason], FAILURE_TEXT[reason].message, FAILURE_TEXT[reason].hint);

export const rescheduleAppointment: ToolHandler<"reschedule_appointment"> = async (input, ctx) => {
  const now = ctx.clock.now().getTime();

  // Scoped to the context patient: someone else's appointment is null, exactly like an unknown ID.
  const current = await ctx.repos.appointments.get(ctx.patientId, input.appointment_id);
  if (!current) return fail("APPOINTMENT_NOT_FOUND");
  if (current.status !== "BOOKED") return fail("APPOINTMENT_NOT_BOOKED");
  // A retry after a successful move: answer before the clock rules, which the new time may now break.
  if (current.slotId === input.new_slot_id) return fail("SAME_SLOT");
  if (Date.parse(current.startUtc) <= now) {
    return toolFail(
      "NOT_ALLOWED",
      "That appointment time has already passed, so it can't be moved. Nothing was changed.",
      BOOK_NEW_HINT,
    );
  }

  const slot = await ctx.repos.slots.get(input.new_slot_id);
  if (!slot) return fail("SLOT_NOT_FOUND");
  if (Date.parse(slot.startUtc) <= now) {
    return toolFail(
      "NOT_ALLOWED",
      "That new time is in the past, so the appointment can't be moved there. The original appointment is unchanged.",
      AVAILABILITY_HINT,
    );
  }

  // Resolved before the write, so a successful move never ends in INTERNAL (and a retry in SAME_SLOT).
  const provider = await ctx.repos.providers.get(slot.providerId);
  if (!provider) throw new Error(`Slot ${slot.slotId} references unknown provider ${slot.providerId}`);

  if (slot.specialty !== current.specialty) {
    return toolFail(
      "NOT_ALLOWED",
      "That new time is for a different kind of visit, so the appointment can't be moved there. Nothing was changed.",
      "Offer times in the appointment's own specialty (check_availability). If the patient wants a different kind of visit, offer to book a new appointment with its own reason (book_appointment) instead.",
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
        "That provider isn't taking new patients, so the appointment can't be moved to them. Nothing was changed.",
        "Tell the patient, then offer another provider in the same specialty: check_availability by specialty lists only providers taking new patients. Move only after the patient confirms.",
      );
    }
  }

  const result = await ctx.repos.appointments.reschedule({
    patientId: ctx.patientId,
    appointmentId: input.appointment_id,
    newSlotId: input.new_slot_id,
  });
  if (!result.ok) return fail(result.reason);

  return toolOk({
    appointment: toAppointmentSummary(result.appointment, provider),
    previous_start_local: formatClinicDateTime(result.previous.startUtc),
  });
};
