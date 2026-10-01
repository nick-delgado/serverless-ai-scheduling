/**
 * Minimal tool handlers for harness tests. The real tools (#19–#23) are built in parallel and
 * `TOOL_REGISTRY` is empty on this branch, so the runner tests register these instead. They follow the
 * contracts closely enough for grading (real ids, `start_local` text, repository writes), nothing more.
 */
import { CLINIC, LIMITS, type AppointmentSummary, type SlotOption } from "@sched/contracts";
import {
  clinicDateRangeUtc,
  formatClinicDateTime,
  toolFail,
  toolOk,
  toZonedParts,
  type Repositories,
  type ToolHandler,
  type ToolRegistry,
} from "@sched/tools";
import type { Appointment, Slot } from "@sched/contracts";

async function providerName(repos: Repositories, providerId: string): Promise<string> {
  return (await repos.providers.get(providerId))?.displayName ?? providerId;
}

async function slotOption(repos: Repositories, s: Slot): Promise<SlotOption> {
  return {
    slot_id: s.slotId,
    provider_id: s.providerId,
    provider_name: await providerName(repos, s.providerId),
    specialty: s.specialty,
    start_utc: s.startUtc,
    start_local: formatClinicDateTime(s.startUtc),
  };
}

async function summary(repos: Repositories, a: Appointment): Promise<AppointmentSummary> {
  return {
    appointment_id: a.appointmentId,
    provider_id: a.providerId,
    provider_name: await providerName(repos, a.providerId),
    specialty: a.specialty,
    start_utc: a.startUtc,
    start_local: formatClinicDateTime(a.startUtc),
    status: a.status,
    reason: a.reason,
  };
}

const checkAvailability: ToolHandler<"check_availability"> = async (input, ctx) => {
  const range = clinicDateRangeUtc(input.date_range.start_date, input.date_range.end_date);
  const providers = input.provider_id
    ? [input.provider_id]
    : (await ctx.repos.providers.list(input.specialty ? { specialty: input.specialty } : {})).map(
        (p) => p.providerId,
      );
  const slots: Slot[] = [];
  for (const id of providers) slots.push(...(await ctx.repos.slots.listOpenByProvider(id, range)));
  const filtered = slots
    .filter((s) => {
      const hour = toZonedParts(new Date(s.startUtc), CLINIC.timezone).hour;
      return input.time_of_day === "any" || (input.time_of_day === "morning" ? hour < 12 : hour >= 12);
    })
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const shown = filtered.slice(0, LIMITS.availabilityMaxSlots);
  return toolOk({
    slots: await Promise.all(shown.map((s) => slotOption(ctx.repos, s))),
    truncated: filtered.length > LIMITS.availabilityMaxSlots,
  });
};

const bookAppointment: ToolHandler<"book_appointment"> = async (input, ctx) => {
  const result = await ctx.repos.appointments.book({
    patientId: ctx.patientId,
    slotId: input.slot_id,
    reason: input.reason,
  });
  if (!result.ok)
    return result.reason === "SLOT_NOT_FOUND"
      ? toolFail("NOT_FOUND", "No such slot.", "Use a slot_id from check_availability.")
      : toolFail("SLOT_UNAVAILABLE", "That slot is no longer available.", "Offer other options.");
  return toolOk({
    appointment: await summary(ctx.repos, result.appointment),
    already_booked: result.alreadyBooked,
  });
};

const rescheduleAppointment: ToolHandler<"reschedule_appointment"> = async (input, ctx) => {
  const result = await ctx.repos.appointments.reschedule({
    patientId: ctx.patientId,
    appointmentId: input.appointment_id,
    newSlotId: input.new_slot_id,
  });
  if (!result.ok) return toolFail("NOT_FOUND", `Reschedule failed: ${result.reason}.`);
  return toolOk({
    appointment: await summary(ctx.repos, result.appointment),
    previous_start_local: formatClinicDateTime(result.previous.startUtc),
  });
};

const getMyAppointments: ToolHandler<"get_my_appointments"> = async (input, ctx) => {
  const now = ctx.clock.now().getTime();
  const all = await ctx.repos.appointments.listForPatient(ctx.patientId);
  const shown = all.filter((a) => input.include_past || Date.parse(a.startUtc) >= now);
  return toolOk({ appointments: await Promise.all(shown.map((a) => summary(ctx.repos, a))) });
};

const escalateToHuman: ToolHandler<"escalate_to_human"> = async (input, ctx) => {
  const result = await ctx.repos.escalations.record({
    patientId: ctx.patientId,
    conversationId: ctx.conversationId,
    reason: input.reason,
    summary: input.summary,
  });
  if (!result.ok) return toolFail("NOT_ALLOWED", "Cannot escalate this conversation.");
  if (!result.alreadyEscalated)
    await ctx.repos.escalations.updateNotification(ctx.patientId, ctx.conversationId, {
      status: "SENT",
      messageId: "msg-test",
    });
  return toolOk({
    escalation_id: result.escalation.escalationId,
    phone: CLINIC.phone,
    hours: CLINIC.hours,
    already_escalated: result.alreadyEscalated,
  });
};

export const DUMMY_REGISTRY: ToolRegistry = {
  check_availability: checkAvailability,
  book_appointment: bookAppointment,
  reschedule_appointment: rescheduleAppointment,
  get_my_appointments: getMyAppointments,
  escalate_to_human: escalateToHuman,
};
