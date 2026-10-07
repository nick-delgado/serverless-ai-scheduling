/**
 * The model-facing summaries the tools return, built from stored records in one place so every tool
 * describes a provider, an appointment or a slot the same way (#77). Times are UTC plus the clinic-local
 * `start_local` (ADR-004).
 */
import type {
  Appointment,
  AppointmentSummary,
  Provider,
  ProviderSummary,
  Slot,
  SlotOption,
} from "@sched/contracts";

import { formatClinicDateTime } from "../clock";

export const toProviderSummary = (p: Provider): ProviderSummary => ({
  provider_id: p.providerId,
  display_name: p.displayName,
  specialty: p.specialty,
  accepting_new_patients: p.acceptingNewPatients,
});

/** `provider` is the appointment's own provider: it gives the display name. */
export const toAppointmentSummary = (a: Appointment, provider: Provider): AppointmentSummary => ({
  appointment_id: a.appointmentId,
  provider_id: a.providerId,
  provider_name: provider.displayName,
  specialty: a.specialty,
  start_utc: a.startUtc,
  start_local: formatClinicDateTime(a.startUtc),
  status: a.status,
  reason: a.reason,
});

/** `provider` is the slot's own provider: it gives the display name. */
export const toSlotOption = (slot: Slot, provider: Provider): SlotOption => ({
  slot_id: slot.slotId,
  provider_id: slot.providerId,
  provider_name: provider.displayName,
  specialty: slot.specialty,
  start_utc: slot.startUtc,
  start_local: formatClinicDateTime(slot.startUtc),
});
