/**
 * get_my_appointments (FR-033): the logged-in patient's appointments, upcoming only unless `include_past`.
 * Identity comes from ctx.patientId (the verified JWT), never from input (CLAUDE.md rule 1).
 *
 * - "Upcoming" means the appointment starts at or after `ctx.clock.now()`; anything that started earlier is
 *   past. Every status is returned (a CANCELLED upcoming appointment is still useful: "did my cancellation
 *   go through?"); the model reads `status`.
 * - In start-time order, ties by appointment id: AP-2 (`appointments.listForPatient`) returns that order in
 *   both repositories, and the filter keeps it.
 * - An empty list is a success, not NOT_FOUND. A patient with no profile also gets `[]`, which reveals nothing.
 * - `reason` is the patient's own stored text: returned as data, never spliced into a message (rule 5).
 */
import type { Provider, ProviderId } from "@sched/contracts";

import { toolOk, type ToolHandler } from "../handler";
import { toAppointmentSummary } from "./summaries";

export const getMyAppointments: ToolHandler<"get_my_appointments"> = async (input, ctx) => {
  const nowMs = ctx.clock.now().getTime();
  const all = await ctx.repos.appointments.listForPatient(ctx.patientId);

  const selected = all.filter((a) => input.include_past || Date.parse(a.startUtc) >= nowMs);

  // One read per distinct provider. A missing provider is a broken invariant (appointments reference seeded
  // providers), so it throws and the executor reports INTERNAL rather than inventing a name.
  const providers = new Map<ProviderId, Provider>();
  for (const providerId of new Set(selected.map((a) => a.providerId))) {
    const provider = await ctx.repos.providers.get(providerId);
    if (!provider) throw new Error(`Appointment references unknown provider ${providerId}`);
    providers.set(providerId, provider);
  }

  return toolOk({
    appointments: selected.map((a) => {
      const provider = providers.get(a.providerId);
      if (!provider) throw new Error(`Provider ${a.providerId} was not loaded`);
      return toAppointmentSummary(a, provider);
    }),
  });
};
