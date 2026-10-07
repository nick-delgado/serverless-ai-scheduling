/**
 * In-memory repositories with the same semantics as the DynamoDB ones (#13): the unit tests and the eval
 * harness (ADR-008) run tools against these, seeded from a fixture, with a FrozenClock and sequential ids.
 *
 * Atomicity: JavaScript runs one callback at a time, so a check-and-mutate with no `await` in between
 * can't interleave with another. Every method first yields once (`await tick()`, like real I/O, so
 * concurrent callers genuinely overlap) and then does all of its reads, checks, validation, and writes
 * synchronously. Nothing is written until every new entity has passed its contracts schema, which is what
 * makes book and reschedule all-or-nothing.
 */
import {
  Appointment,
  ConversationMessage,
  Escalation,
  PatientId,
  Slot,
  type AppointmentId,
  type ConversationId,
  type IsoDate,
  type Patient,
  type Provider,
  type ProviderId,
  type SlotId,
  type Specialty,
} from "@sched/contracts";

import { clinicDateOf, type Clock } from "../clock";
import { randomIds } from "./ids";
import { compareProviders, providerMatchesName } from "./provider-match";
import { validateSeed, type ClinicSeed } from "./seed";
import {
  ConversationAppendError,
  MAX_APPEND_BATCH,
  type AppointmentRepo,
  type BookCommand,
  type BookResult,
  type ConversationRepo,
  type ConversationSummary,
  type EscalationRepo,
  type IdGenerator,
  type NewEscalation,
  type PatientRepo,
  type ProviderFilter,
  type ProviderRepo,
  type RecordEscalationResult,
  type RescheduleCommand,
  type RescheduleResult,
  type Repositories,
  type SlotRepo,
  type UtcRange,
} from "./types";

export interface InMemoryRepositoryOptions {
  /** Source of `createdAt`/`updatedAt`. Use a FrozenClock in tests and evals. */
  clock: Clock;
  /** Defaults to `randomIds()`; use `sequentialIds()` for deterministic runs. */
  ids?: IdGenerator;
  /** Initial data, validated with `validateSeed`. */
  seed?: ClinicSeed;
}

interface StoredConversation {
  patientId: PatientId;
  createdAt: string;
  messages: Map<number, ConversationMessage>;
}

/** Everything in the store, as plain sorted data. For eval end-state diffs (ADR-008) and debugging. */
export interface InMemorySnapshot {
  patients: Patient[];
  providers: Provider[];
  slots: Slot[];
  appointments: Appointment[];
  conversations: { conversationId: ConversationId; patientId: PatientId; messages: ConversationMessage[] }[];
  escalations: Escalation[];
}

export interface InMemoryRepositories extends Repositories {
  snapshot(): InMemorySnapshot;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const copy = <T>(value: T): T => structuredClone(value);
const instant = (iso: string): number => Date.parse(iso);
const byStart = (a: { startUtc: string }, b: { startUtc: string }): number =>
  instant(a.startUtc) - instant(b.startUtc);
const byKey =
  <T>(key: (t: T) => string) =>
  (a: T, b: T): number =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

export function createInMemoryRepositories(options: InMemoryRepositoryOptions): InMemoryRepositories {
  const { clock } = options;
  const ids = options.ids ?? randomIds();
  const seed = options.seed ? validateSeed(options.seed) : undefined;

  const patients = new Map<PatientId, Patient>(seed?.patients.map((p) => [p.patientId, p]));
  const providers = new Map<ProviderId, Provider>(seed?.providers.map((p) => [p.providerId, p]));
  const slots = new Map<SlotId, Slot>(seed?.slots.map((s) => [s.slotId, s]));
  const appointments = new Map<AppointmentId, Appointment>(
    seed?.appointments.map((a) => [a.appointmentId, a]),
  );
  const conversations = new Map<ConversationId, StoredConversation>();
  const escalations = new Map<ConversationId, Escalation>();

  const nowIso = (): string => clock.now().toISOString();
  const ownAppointment = (patientId: PatientId, appointmentId: AppointmentId): Appointment | undefined => {
    const appt = appointments.get(appointmentId);
    return appt && appt.patientId === patientId ? appt : undefined;
  };

  // -------------------------------------------------------------------------------------------
  const patientRepo: PatientRepo = {
    async get(patientId) {
      await tick();
      const patient = patients.get(patientId);
      return patient ? copy(patient) : null;
    },
  };

  // -------------------------------------------------------------------------------------------
  const providerRepo: ProviderRepo = {
    async get(providerId) {
      await tick();
      const provider = providers.get(providerId);
      return provider ? copy(provider) : null;
    },
    async list(filter: ProviderFilter = {}) {
      await tick();
      const { specialty, nameQuery } = filter;
      return [...providers.values()]
        .filter((p) => specialty === undefined || p.specialty === specialty)
        .filter((p) => nameQuery === undefined || providerMatchesName(p, nameQuery))
        .sort(compareProviders)
        .map(copy);
    },
  };

  // -------------------------------------------------------------------------------------------
  const slotRepo: SlotRepo = {
    async get(slotId) {
      await tick();
      const slot = slots.get(slotId);
      return slot ? copy(slot) : null;
    },
    async listOpenByProvider(providerId: ProviderId, range: UtcRange) {
      await tick();
      const from = instant(range.fromUtc);
      const to = instant(range.toUtc);
      if (Number.isNaN(from) || Number.isNaN(to))
        throw new RangeError(`Invalid range ${JSON.stringify(range)}`);
      return [...slots.values()]
        .filter((s) => s.providerId === providerId && s.status === "OPEN")
        .filter((s) => instant(s.startUtc) >= from && instant(s.startUtc) < to)
        .sort(byStart)
        .map(copy);
    },
    async listOpenBySpecialtyAndDay(specialty: Specialty, day: IsoDate) {
      await tick();
      return [...slots.values()]
        .filter((s) => s.specialty === specialty && s.status === "OPEN" && clinicDateOf(s.startUtc) === day)
        .sort((a, b) => byStart(a, b) || byKey<Slot>((s) => s.providerId)(a, b))
        .map(copy);
    },
  };

  // -------------------------------------------------------------------------------------------
  const appointmentRepo: AppointmentRepo = {
    async get(patientId, appointmentId) {
      await tick();
      const appt = ownAppointment(patientId, appointmentId);
      return appt ? copy(appt) : null;
    },

    async listForPatient(patientId) {
      await tick();
      return [...appointments.values()]
        .filter((a) => a.patientId === patientId)
        .sort((a, b) => byStart(a, b) || byKey<Appointment>((x) => x.appointmentId)(a, b))
        .map(copy);
    },

    async book({ patientId, slotId, reason }: BookCommand): Promise<BookResult> {
      PatientId.parse(patientId);
      const cleanReason = Appointment.shape.reason.parse(reason);
      await tick();
      // ---- synchronous from here: check and mutate as one step (AP-6) ----
      const slot = slots.get(slotId);
      if (!slot) return { ok: false, reason: "SLOT_NOT_FOUND" };
      if (slot.status !== "OPEN") {
        const holder = slot.appointmentId ? appointments.get(slot.appointmentId) : undefined;
        if (holder && holder.patientId === patientId && holder.status === "BOOKED") {
          return { ok: true, appointment: copy(holder), alreadyBooked: true };
        }
        return { ok: false, reason: "SLOT_UNAVAILABLE" };
      }
      const appointmentId = ids.appointmentId();
      if (appointments.has(appointmentId))
        throw new Error(`IdGenerator returned a duplicate id ${appointmentId}`);
      const now = nowIso();
      const appointment = Appointment.parse({
        appointmentId,
        patientId,
        providerId: slot.providerId,
        slotId: slot.slotId,
        specialty: slot.specialty,
        startUtc: slot.startUtc,
        endUtc: slot.endUtc,
        status: "BOOKED",
        reason: cleanReason,
        createdAt: now,
        updatedAt: now,
      });
      const bookedSlot = Slot.parse({ ...slot, status: "BOOKED", appointmentId });
      slots.set(slotId, bookedSlot);
      appointments.set(appointmentId, appointment);
      return { ok: true, appointment: copy(appointment), alreadyBooked: false };
    },

    async reschedule({ patientId, appointmentId, newSlotId }: RescheduleCommand): Promise<RescheduleResult> {
      PatientId.parse(patientId);
      await tick();
      // ---- synchronous from here: check and mutate as one step (AP-7) ----
      const appt = ownAppointment(patientId, appointmentId);
      if (!appt) return { ok: false, reason: "APPOINTMENT_NOT_FOUND" };
      if (appt.status !== "BOOKED") return { ok: false, reason: "APPOINTMENT_NOT_BOOKED" };
      if (appt.slotId === newSlotId) return { ok: true, alreadyRescheduled: true, appointment: copy(appt) };
      const newSlot = slots.get(newSlotId);
      if (!newSlot) return { ok: false, reason: "SLOT_NOT_FOUND" };
      if (newSlot.status !== "OPEN") return { ok: false, reason: "SLOT_UNAVAILABLE" };
      const oldSlot = slots.get(appt.slotId);
      if (!oldSlot || oldSlot.appointmentId !== appt.appointmentId) {
        // The DynamoDB condition `appointmentId = :appt` on the old slot would fail here too.
        throw new Error(`Invariant violated: appointment ${appointmentId} does not hold slot ${appt.slotId}`);
      }

      // Build and validate every new version first; write only if all of them are valid.
      const { appointmentId: _released, ...oldSlotRest } = oldSlot;
      const releasedOldSlot = Slot.parse({ ...oldSlotRest, status: "OPEN" });
      const bookedNewSlot = Slot.parse({ ...newSlot, status: "BOOKED", appointmentId });
      const moved = Appointment.parse({
        ...appt,
        providerId: newSlot.providerId,
        slotId: newSlot.slotId,
        specialty: newSlot.specialty,
        startUtc: newSlot.startUtc,
        endUtc: newSlot.endUtc,
        updatedAt: nowIso(),
      });

      slots.set(oldSlot.slotId, releasedOldSlot);
      slots.set(newSlot.slotId, bookedNewSlot);
      appointments.set(appointmentId, moved);
      return { ok: true, alreadyRescheduled: false, appointment: copy(moved), previous: copy(appt) };
    },
  };

  // -------------------------------------------------------------------------------------------
  const conversationRepo: ConversationRepo = {
    async append(patientId, messages) {
      PatientId.parse(patientId);
      const batch = messages.map((m) => ConversationMessage.parse(m));
      const first = batch[0];
      if (!first) throw new RangeError("append needs at least one message");
      if (batch.length > MAX_APPEND_BATCH) {
        throw new RangeError(`append takes at most ${MAX_APPEND_BATCH} messages, got ${batch.length}`);
      }
      batch.forEach((m, i) => {
        if (m.conversationId !== first.conversationId)
          throw new RangeError("append batch mixes conversations");
        if (m.seq !== first.seq + i)
          throw new RangeError(`append batch seqs must be consecutive from ${first.seq}`);
      });
      const { conversationId } = first;
      await tick();
      // ---- synchronous from here (AP-8) ----
      const existing = conversations.get(conversationId);
      if (first.seq > 0) {
        const predecessor =
          existing?.patientId === patientId ? existing.messages.get(first.seq - 1) : undefined;
        if (!predecessor) throw new ConversationAppendError("PREDECESSOR_MISSING", conversationId, first.seq);
      }
      for (const m of batch) {
        if (existing?.messages.has(m.seq))
          throw new ConversationAppendError("SEQ_CONFLICT", conversationId, m.seq);
      }
      const conversation = existing ?? { patientId, createdAt: first.createdAt, messages: new Map() };
      for (const m of batch) conversation.messages.set(m.seq, m);
      conversations.set(conversationId, conversation);
    },

    async listMessages(patientId, conversationId) {
      await tick();
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.patientId !== patientId) return [];
      return [...conversation.messages.values()].sort((a, b) => a.seq - b.seq).map(copy);
    },

    async listConversations(patientId, options = {}) {
      await tick();
      const summaries: ConversationSummary[] = [...conversations.entries()]
        .filter(([, c]) => c.patientId === patientId)
        .map(([conversationId, c]) => ({ conversationId, patientId: c.patientId, createdAt: c.createdAt }))
        // Meta SK `CONV#<createdAt>#<id>`, read descending.
        .sort(byKey<ConversationSummary>((s) => `${s.createdAt}#${s.conversationId}`))
        .reverse();
      return options.limit === undefined ? summaries : summaries.slice(0, Math.max(0, options.limit));
    },
  };

  // -------------------------------------------------------------------------------------------
  const escalationRepo: EscalationRepo = {
    async record(input: NewEscalation): Promise<RecordEscalationResult> {
      await tick();
      // ---- synchronous from here (AP-9, at most once per conversation) ----
      const existing = escalations.get(input.conversationId);
      if (existing) {
        return existing.patientId === input.patientId
          ? { ok: true, escalation: copy(existing), alreadyEscalated: true }
          : { ok: false, reason: "NOT_OWNER" };
      }
      const escalation = Escalation.parse({
        escalationId: ids.escalationId(),
        conversationId: input.conversationId,
        patientId: input.patientId,
        reason: input.reason,
        summary: input.summary,
        createdAt: nowIso(),
        notification: input.notification ?? { status: "PENDING" },
      });
      escalations.set(escalation.conversationId, escalation);
      return { ok: true, escalation: copy(escalation), alreadyEscalated: false };
    },

    async getForConversation(patientId, conversationId) {
      await tick();
      const escalation = escalations.get(conversationId);
      return escalation && escalation.patientId === patientId ? copy(escalation) : null;
    },

    async updateNotification(patientId, conversationId, notification) {
      await tick();
      const escalation = escalations.get(conversationId);
      if (!escalation || escalation.patientId !== patientId) return null;
      const updated = Escalation.parse({ ...escalation, notification });
      escalations.set(conversationId, updated);
      return copy(updated);
    },
  };

  return {
    patients: patientRepo,
    providers: providerRepo,
    slots: slotRepo,
    appointments: appointmentRepo,
    conversations: conversationRepo,
    escalations: escalationRepo,
    snapshot: () =>
      copy({
        patients: [...patients.values()].sort(byKey((p) => p.patientId)),
        providers: [...providers.values()].sort(compareProviders),
        slots: [...slots.values()].sort((a, b) => byStart(a, b) || byKey<Slot>((s) => s.providerId)(a, b)),
        appointments: [...appointments.values()].sort(byKey((a) => a.appointmentId)),
        conversations: [...conversations.entries()]
          .map(([conversationId, c]) => ({
            conversationId,
            patientId: c.patientId,
            messages: [...c.messages.values()].sort((a, b) => a.seq - b.seq),
          }))
          .sort(byKey((c) => c.conversationId)),
        escalations: [...escalations.values()].sort(byKey((e) => e.conversationId)),
      }),
  };
}
