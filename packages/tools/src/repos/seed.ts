/**
 * The data a repository is seeded with (the clinic fixture, a contract-test scenario, or the dev seed
 * script in #14), plus a validator that checks every entity against @sched/contracts and the
 * cross-entity invariants the booking transactions rely on.
 */
import {
  Appointment,
  makeSlotId,
  Patient,
  Provider,
  Slot,
  toCanonicalUtc,
  type AppointmentId,
  type SlotId,
} from "@sched/contracts";

export interface ClinicSeed {
  patients: readonly Patient[];
  providers: readonly Provider[];
  slots: readonly Slot[];
  appointments: readonly Appointment[];
}

export class SeedValidationError extends Error {
  override readonly name = "SeedValidationError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const shown = problems.slice(0, 10).join("\n  - ");
    const more = problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : "";
    super(`Invalid seed (${problems.length} problem(s)):\n  - ${shown}${more}`);
    this.problems = problems;
  }
}

/**
 * Parse every entity with its contracts schema and check the invariants:
 * - ids are unique; slot ids encode `(providerId, startUtc)` (`makeSlotId`) with canonical minute-precision times;
 * - a slot's specialty is its provider's; appointments reference existing patients and providers;
 * - a BOOKED slot is held by a BOOKED appointment for that same slot, and vice versa, with matching
 *   provider, specialty, and times;
 * - a CANCELLED or COMPLETED appointment holds no slot (its slot, if seeded, is OPEN or someone else's).
 *
 * Returns the parsed seed (fresh objects). Throws SeedValidationError listing every problem found.
 */
export function validateSeed(seed: ClinicSeed): ClinicSeed {
  const problems: string[] = [];
  const parsed: { patients: Patient[]; providers: Provider[]; slots: Slot[]; appointments: Appointment[] } = {
    patients: [],
    providers: [],
    slots: [],
    appointments: [],
  };

  const parseAll = <T>(
    label: string,
    items: readonly unknown[],
    schema: {
      safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } };
    },
    out: T[],
  ): void => {
    items.forEach((item, i) => {
      const r = schema.safeParse(item);
      if (r.success) out.push(r.data);
      else problems.push(`${label}[${i}] is invalid: ${r.error.message}`);
    });
  };
  parseAll("patients", seed.patients, Patient, parsed.patients);
  parseAll("providers", seed.providers, Provider, parsed.providers);
  parseAll("slots", seed.slots, Slot, parsed.slots);
  parseAll("appointments", seed.appointments, Appointment, parsed.appointments);
  if (problems.length > 0) throw new SeedValidationError(problems);

  const unique = <T>(label: string, items: readonly T[], key: (t: T) => string): Map<string, T> => {
    const map = new Map<string, T>();
    for (const item of items) {
      const k = key(item);
      if (map.has(k)) problems.push(`duplicate ${label} ${k}`);
      map.set(k, item);
    }
    return map;
  };
  const patients = unique("patientId", parsed.patients, (p) => p.patientId);
  const providers = unique("providerId", parsed.providers, (p) => p.providerId);
  const slots = unique("slotId", parsed.slots, (s) => s.slotId);
  const appointments = unique("appointmentId", parsed.appointments, (a) => a.appointmentId);

  const canonical = (label: string, iso: string): void => {
    try {
      if (toCanonicalUtc(iso) !== iso)
        problems.push(`${label} ${iso} is not canonical (YYYY-MM-DDTHH:MM:00Z)`);
    } catch {
      problems.push(`${label} ${iso} is not on a whole minute`);
    }
  };
  const expectedSlotId = (providerId: string, startUtc: string): SlotId | null => {
    try {
      return makeSlotId(providerId, startUtc);
    } catch {
      return null;
    }
  };

  const slotHolders = new Map<AppointmentId, SlotId>();
  for (const slot of parsed.slots) {
    const provider = providers.get(slot.providerId);
    if (!provider) problems.push(`slot ${slot.slotId}: unknown provider ${slot.providerId}`);
    else if (provider.specialty !== slot.specialty) {
      problems.push(`slot ${slot.slotId}: specialty ${slot.specialty} != provider's ${provider.specialty}`);
    }
    canonical(`slot ${slot.slotId} startUtc`, slot.startUtc);
    canonical(`slot ${slot.slotId} endUtc`, slot.endUtc);
    if (expectedSlotId(slot.providerId, slot.startUtc) !== slot.slotId) {
      problems.push(`slot ${slot.slotId}: id does not encode (${slot.providerId}, ${slot.startUtc})`);
    }
    if (slot.appointmentId) {
      const appt = appointments.get(slot.appointmentId);
      if (!appt) problems.push(`slot ${slot.slotId}: unknown appointment ${slot.appointmentId}`);
      else if (appt.status !== "BOOKED" || appt.slotId !== slot.slotId) {
        problems.push(
          `slot ${slot.slotId}: held by ${appt.appointmentId}, which is ${appt.status} in ${appt.slotId}`,
        );
      }
      if (slotHolders.has(slot.appointmentId)) {
        problems.push(`appointment ${slot.appointmentId} holds more than one slot`);
      }
      slotHolders.set(slot.appointmentId, slot.slotId);
    }
  }

  for (const appt of parsed.appointments) {
    const where = `appointment ${appt.appointmentId}`;
    if (!patients.has(appt.patientId)) problems.push(`${where}: unknown patient ${appt.patientId}`);
    const provider = providers.get(appt.providerId);
    if (!provider) problems.push(`${where}: unknown provider ${appt.providerId}`);
    else if (provider.specialty !== appt.specialty) problems.push(`${where}: specialty != provider's`);
    if (expectedSlotId(appt.providerId, appt.startUtc) !== appt.slotId) {
      problems.push(`${where}: slotId ${appt.slotId} does not encode (${appt.providerId}, ${appt.startUtc})`);
    }
    if (appt.status === "BOOKED") {
      const slot = slots.get(appt.slotId);
      if (!slot) problems.push(`${where}: BOOKED but slot ${appt.slotId} is not seeded`);
      else if (slot.appointmentId !== appt.appointmentId) {
        problems.push(`${where}: BOOKED but slot ${appt.slotId} is not held by it`);
      } else if (slot.endUtc !== appt.endUtc) problems.push(`${where}: endUtc differs from its slot`);
    } else if (slotHolders.has(appt.appointmentId)) {
      problems.push(`${where}: ${appt.status} but still holds slot ${slotHolders.get(appt.appointmentId)}`);
    }
  }

  if (problems.length > 0) throw new SeedValidationError(problems);
  return structuredClone(parsed);
}
