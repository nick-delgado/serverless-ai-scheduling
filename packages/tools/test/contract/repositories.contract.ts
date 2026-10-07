/**
 * The repository contract suite (ADR-004 "both run the same contract test suite").
 *
 * Every Repositories implementation must pass this: the in-memory one here, and the DynamoDB one in #13:
 *
 *   runRepositoryContract("dynamodb-local", async (seed, { clock, ids }) => {
 *     const table = await createFreshTable();          // your setup
 *     await writeSeed(table, seed);
 *     return createDynamoRepositories({ table, clock, ids });
 *   });
 *
 * The suite reads state only through the public interfaces, so it never depends on storage details.
 * Each test gets a fresh store seeded with `contractSeed()`, a FrozenClock at NOW, and a recording IdGenerator.
 */
import {
  Appointment,
  ConversationMessage,
  Escalation,
  Patient,
  Provider,
  Slot,
  type AppointmentId,
  type EscalationId,
  type PatientId,
  type SlotId,
} from "@sched/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { FrozenClock, type Clock } from "../../src/clock";
import { sequentialIds } from "../../src/repos/ids";
import type { ClinicSeed } from "../../src/repos/seed";
import { ConversationAppendError, type IdGenerator, type Repositories } from "../../src/repos/types";
import {
  AISHA,
  APPT,
  CONV_A,
  CONV_B,
  CROWD,
  DANIEL,
  MARIA,
  NOW,
  SLOT,
  WALTER,
  contractSeed,
  message,
} from "./scenario";

export interface RepositoryDeps {
  clock: Clock;
  ids: IdGenerator;
}

/** Build a fresh, isolated set of repositories holding exactly `seed`. */
export type MakeRepositories = (
  seed: ClinicSeed,
  deps: RepositoryDeps,
) => Promise<Repositories> | Repositories;

/** An IdGenerator that remembers what it issued, so tests can check ids came from it without predicting order. */
function recordingIds(): IdGenerator & { issued: Set<string> } {
  const inner = sequentialIds();
  const issued = new Set<string>();
  return {
    issued,
    appointmentId(): AppointmentId {
      const id = inner.appointmentId();
      issued.add(id);
      return id;
    },
    escalationId(): EscalationId {
      const id = inner.escalationId();
      issued.add(id);
      return id;
    },
  };
}

const ALL_PATIENTS: PatientId[] = contractSeed().patients.map((p) => p.patientId);

export function runRepositoryContract(name: string, makeRepos: MakeRepositories): void {
  describe(`repository contract: ${name}`, () => {
    let repos: Repositories;
    let clock: FrozenClock;
    let ids: ReturnType<typeof recordingIds>;

    beforeEach(async () => {
      clock = new FrozenClock(NOW);
      ids = recordingIds();
      repos = await makeRepos(contractSeed(), { clock, ids });
    });

    /** Everything a write could touch, read through the interfaces. */
    async function capture(patientIds: PatientId[], slotIds: SlotId[]) {
      return {
        slots: await Promise.all(slotIds.map((id) => repos.slots.get(id))),
        appointments: await Promise.all(patientIds.map((id) => repos.appointments.listForPatient(id))),
      };
    }

    /** Every BOOKED slot is held by exactly one BOOKED appointment for it (across all seeded patients), and vice versa. */
    async function expectConsistent(slotIds: SlotId[]) {
      const booked = (await Promise.all(ALL_PATIENTS.map((id) => repos.appointments.listForPatient(id))))
        .flat()
        .filter((a) => a.status === "BOOKED");
      for (const appt of booked) {
        const slot = await repos.slots.get(appt.slotId);
        expect(slot, `slot of ${appt.appointmentId}`).toMatchObject({
          status: "BOOKED",
          appointmentId: appt.appointmentId,
        });
      }
      for (const slotId of slotIds) {
        const slot = await repos.slots.get(slotId);
        if (slot?.status === "BOOKED") {
          expect(
            booked.filter((a) => a.appointmentId === slot.appointmentId && a.slotId === slotId),
          ).toHaveLength(1);
        }
      }
    }

    // -----------------------------------------------------------------------------------------
    describe("patients (AP-1)", () => {
      it("gets a profile by id, valid per the contracts schema", async () => {
        const maria = await repos.patients.get(MARIA);
        expect(Patient.parse(maria)).toMatchObject({
          firstName: "Maria",
          lastName: "Santos",
          preferredProviderId: "prov_lee",
        });
      });

      it("returns null for an unknown patient", async () => {
        expect(await repos.patients.get("11111111-1111-4111-8111-111111111111")).toBeNull();
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("providers (AP-3)", () => {
      it("gets one provider by id; unknown → null", async () => {
        expect(Provider.parse(await repos.providers.get("prov_lee")).displayName).toBe("Dr. Priya Lee");
        expect(await repos.providers.get("prov_nobody")).toBeNull();
      });

      it("lists all providers ordered by specialty, then last name", async () => {
        const all = await repos.providers.list();
        expect(all).toHaveLength(8);
        expect(all.map((p) => p.providerId)).toEqual([
          "prov_haddad", // cardiology
          "prov_lee", // dermatology
          "prov_okafor",
          "prov_alvarez", // family_medicine
          "prov_brooks",
          "prov_chen", // pediatrics
          "prov_nakamura",
          "prov_kowalski", // physical_therapy
        ]);
      });

      it("filters by specialty", async () => {
        const derm = await repos.providers.list({ specialty: "dermatology" });
        expect(derm.map((p) => p.displayName)).toEqual(["Dr. Priya Lee", "Dr. Samuel Okafor"]);
      });

      it.each([
        ["Lee", ["prov_lee"]],
        ["dr. okafor", ["prov_okafor"]],
        ["Dr Okafor", ["prov_okafor"]],
        ["PRIYA", ["prov_lee"]],
        ["priya lee", ["prov_lee"]],
        ["Nakam", ["prov_nakamura"]],
        ["Smith", []],
        ["priya okafor", []],
      ])("matches name query %j", async (nameQuery, expected) => {
        expect((await repos.providers.list({ nameQuery })).map((p) => p.providerId)).toEqual(expected);
      });

      it("combines specialty and name", async () => {
        expect(await repos.providers.list({ specialty: "cardiology", nameQuery: "Lee" })).toEqual([]);
        expect(
          (await repos.providers.list({ specialty: "dermatology", nameQuery: "Lee" })).map(
            (p) => p.providerId,
          ),
        ).toEqual(["prov_lee"]);
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("slots (AP-4, AP-5)", () => {
      it("gets a slot by id; unknown or malformed ids → null", async () => {
        expect(Slot.parse(await repos.slots.get(SLOT.leeTue2pm))).toMatchObject({
          providerId: "prov_lee",
          specialty: "dermatology",
          startUtc: "2026-10-13T18:00:00Z",
          endUtc: "2026-10-13T18:30:00Z",
          status: "OPEN",
        });
        expect(await repos.slots.get(SLOT.notSeeded)).toBeNull();
        expect(await repos.slots.get("slot_garbage")).toBeNull();
      });

      it("lists a provider's OPEN slots in a half-open UTC range, ascending", async () => {
        const slots = await repos.slots.listOpenByProvider("prov_lee", {
          fromUtc: "2026-10-13T18:00:00Z",
          toUtc: "2026-10-13T20:00:00Z",
        });
        // 14:00, 14:30 (BOOKED by Maria, excluded), 15:00, 15:30 ET; 16:00 ET (20:00Z) is the exclusive end.
        expect(slots.map((s) => s.slotId)).toEqual([SLOT.leeTue2pm, SLOT.leeTue3pm, SLOT.leeTue330pm]);
      });

      it("returns no slots for an empty range or an unknown provider", async () => {
        const range = { fromUtc: "2026-10-13T18:00:00Z", toUtc: "2026-10-13T18:00:00Z" };
        expect(await repos.slots.listOpenByProvider("prov_lee", range)).toEqual([]);
        expect(
          await repos.slots.listOpenByProvider("prov_nobody", {
            fromUtc: NOW,
            toUtc: "2026-11-01T00:00:00Z",
          }),
        ).toEqual([]);
      });

      it("lists OPEN slots for a specialty on one clinic-local day, by start then provider", async () => {
        const slots = await repos.slots.listOpenBySpecialtyAndDay("dermatology", "2026-10-13");
        expect(slots).toHaveLength(2 * 18 - 1); // two dermatologists, 18 slots each, minus Maria's
        expect(slots.map((s) => s.slotId)).not.toContain(SLOT.mariaHeld);
        expect(slots.slice(0, 2).map((s) => s.slotId)).toEqual([
          "slot_lee_20261013T1200Z",
          "slot_okafor_20261013T1200Z",
        ]);
        for (let i = 1; i < slots.length; i++) {
          const [prev, cur] = [slots[i - 1], slots[i]];
          expect(Date.parse(cur?.startUtc ?? "") >= Date.parse(prev?.startUtc ?? "")).toBe(true);
        }
        expect(await repos.slots.listOpenBySpecialtyAndDay("dermatology", "2026-10-15")).toEqual([]);
        expect(await repos.slots.listOpenBySpecialtyAndDay("cardiology", "2026-10-13")).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("appointments (AP-2)", () => {
      it("lists only the patient's own appointments, all statuses, ascending by start", async () => {
        const walter = await repos.appointments.listForPatient(WALTER);
        expect(walter.map((a) => [a.appointmentId, a.status])).toEqual([
          [APPT.walterPast, "COMPLETED"],
          [APPT.walterHaddad, "BOOKED"],
        ]);
        walter.forEach((a) => Appointment.parse(a));
        expect(await repos.appointments.listForPatient(AISHA)).toEqual([]);
      });

      it("gets an appointment only through its owner", async () => {
        expect((await repos.appointments.get(MARIA, APPT.mariaLee))?.slotId).toBe(SLOT.mariaHeld);
        expect(await repos.appointments.get(WALTER, APPT.mariaLee)).toBeNull();
        expect(await repos.appointments.get(MARIA, "appt_0000000999")).toBeNull();
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("book (AP-6, NFR-008)", () => {
      it("books an OPEN slot: slot → BOOKED + a new BOOKED appointment, atomically", async () => {
        const result = await repos.appointments.book({
          patientId: AISHA,
          slotId: SLOT.leeTue2pm,
          reason: "  Skin check ",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const appt = Appointment.parse(result.appointment);
        expect(result.alreadyBooked).toBe(false);
        expect(ids.issued.has(appt.appointmentId)).toBe(true);
        expect(appt).toMatchObject({
          patientId: AISHA,
          providerId: "prov_lee",
          slotId: SLOT.leeTue2pm,
          specialty: "dermatology",
          startUtc: "2026-10-13T18:00:00Z",
          endUtc: "2026-10-13T18:30:00Z",
          status: "BOOKED",
          reason: "Skin check",
          createdAt: NOW,
          updatedAt: NOW,
        });
        expect(await repos.slots.get(SLOT.leeTue2pm)).toMatchObject({
          status: "BOOKED",
          appointmentId: appt.appointmentId,
        });
        expect(await repos.appointments.listForPatient(AISHA)).toEqual([appt]);
      });

      it("removes a booked slot from both open-slot queries (the sparse index)", async () => {
        await repos.appointments.book({ patientId: AISHA, slotId: SLOT.leeTue2pm, reason: "Skin check" });
        const byDay = await repos.slots.listOpenBySpecialtyAndDay("dermatology", "2026-10-13");
        const byProvider = await repos.slots.listOpenByProvider("prov_lee", {
          fromUtc: "2026-10-13T00:00:00Z",
          toUtc: "2026-10-14T00:00:00Z",
        });
        expect(byDay.map((s) => s.slotId)).not.toContain(SLOT.leeTue2pm);
        expect(byProvider.map((s) => s.slotId)).not.toContain(SLOT.leeTue2pm);
      });

      it("is idempotent: the same patient re-booking the slot gets the existing appointment back", async () => {
        const first = await repos.appointments.book({
          patientId: AISHA,
          slotId: SLOT.leeTue2pm,
          reason: "Skin check",
        });
        clock.advance({ minutes: 5 });
        const again = await repos.appointments.book({
          patientId: AISHA,
          slotId: SLOT.leeTue2pm,
          reason: "Different words",
        });
        expect(first.ok && again.ok).toBe(true);
        if (!first.ok || !again.ok) return;
        expect(again.alreadyBooked).toBe(true);
        expect(again.appointment).toEqual(first.appointment); // original reason and timestamps
        expect(await repos.appointments.listForPatient(AISHA)).toHaveLength(1);
      });

      it("treats a seeded appointment the same way (Maria re-booking her own slot)", async () => {
        const result = await repos.appointments.book({
          patientId: MARIA,
          slotId: SLOT.mariaHeld,
          reason: "Mole check",
        });
        expect(result).toMatchObject({
          ok: true,
          alreadyBooked: true,
          appointment: { appointmentId: APPT.mariaLee },
        });
      });

      it("returns SLOT_UNAVAILABLE when another patient holds the slot, and changes nothing", async () => {
        const before = await capture([MARIA, AISHA], [SLOT.mariaHeld]);
        const result = await repos.appointments.book({
          patientId: AISHA,
          slotId: SLOT.mariaHeld,
          reason: "Skin check",
        });
        expect(result).toEqual({ ok: false, reason: "SLOT_UNAVAILABLE" });
        expect(await capture([MARIA, AISHA], [SLOT.mariaHeld])).toEqual(before);
      });

      it("returns SLOT_NOT_FOUND for an unknown slot", async () => {
        const result = await repos.appointments.book({
          patientId: AISHA,
          slotId: SLOT.notSeeded,
          reason: "Skin check",
        });
        expect(result).toEqual({ ok: false, reason: "SLOT_NOT_FOUND" });
        expect(await repos.appointments.listForPatient(AISHA)).toEqual([]);
      });

      it("can book a slot released by a cancelled appointment", async () => {
        const result = await repos.appointments.book({
          patientId: DANIEL,
          slotId: SLOT.danielCancelled,
          reason: "Rash",
        });
        expect(result).toMatchObject({ ok: true, alreadyBooked: false });
        const daniel = await repos.appointments.listForPatient(DANIEL);
        expect(
          daniel
            .filter((a) => a.slotId === SLOT.danielCancelled)
            .map((a) => a.status)
            .sort(),
        ).toEqual(["BOOKED", "CANCELLED"]);
      });

      it("rejects an invalid reason without writing anything", async () => {
        await expect(
          repos.appointments.book({ patientId: AISHA, slotId: SLOT.leeTue2pm, reason: "   " }),
        ).rejects.toThrow();
        await expect(
          repos.appointments.book({ patientId: AISHA, slotId: SLOT.leeTue2pm, reason: "x".repeat(301) }),
        ).rejects.toThrow();
        expect(await repos.slots.get(SLOT.leeTue2pm)).toMatchObject({ status: "OPEN" });
      });

      it("10 parallel bookings of one slot by different patients → exactly 1 succeeds", async () => {
        const results = await Promise.all(
          CROWD.map((patientId) =>
            repos.appointments.book({ patientId, slotId: SLOT.leeTue3pm, reason: "Skin check" }),
          ),
        );
        const winners = results.flatMap((r, i) => (r.ok ? [{ result: r, patientId: CROWD[i] }] : []));
        expect(winners).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual(
          Array(9).fill({ ok: false, reason: "SLOT_UNAVAILABLE" }),
        );

        const winner = winners[0];
        const slot = await repos.slots.get(SLOT.leeTue3pm);
        expect(slot?.appointmentId).toBe(winner?.result.appointment.appointmentId);
        const held = await Promise.all(CROWD.map((id) => repos.appointments.listForPatient(id)));
        expect(held.map((list) => list.length).sort()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        await expectConsistent([SLOT.leeTue3pm]);
      });

      it("10 parallel bookings of one slot by the same patient → 1 appointment, 9 idempotent replies", async () => {
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            repos.appointments.book({ patientId: AISHA, slotId: SLOT.leeTue3pm, reason: "Skin check" }),
          ),
        );
        expect(results.every((r) => r.ok)).toBe(true);
        const oks = results.flatMap((r) => (r.ok ? [r] : []));
        expect(oks.filter((r) => !r.alreadyBooked)).toHaveLength(1);
        expect(new Set(oks.map((r) => r.appointment.appointmentId)).size).toBe(1);
        expect(await repos.appointments.listForPatient(AISHA)).toHaveLength(1);
      });

      it("parallel bookings of different slots all succeed (no false conflicts)", async () => {
        const slotIds = [
          SLOT.leeTue2pm,
          SLOT.leeTue3pm,
          SLOT.leeTue330pm,
          SLOT.okaforTue4pm,
          SLOT.leeWed10am,
        ];
        const results = await Promise.all(
          slotIds.map((slotId, i) =>
            repos.appointments.book({ patientId: CROWD[i] ?? AISHA, slotId, reason: "Skin check" }),
          ),
        );
        expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
        await expectConsistent(slotIds);
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("reschedule (AP-7, NFR-008)", () => {
      const touched = [SLOT.mariaHeld, SLOT.leeTue2pm, SLOT.leeTue3pm, SLOT.walterHeld, SLOT.okaforTue4pm];

      it("moves the appointment: old slot released, new slot booked, appointment updated", async () => {
        clock.advance({ hours: 1 });
        const result = await repos.appointments.reschedule({
          patientId: MARIA,
          appointmentId: APPT.mariaLee,
          newSlotId: SLOT.okaforTue4pm,
        });
        expect(result).toMatchObject({ ok: true, alreadyRescheduled: false });
        if (!result.ok || result.alreadyRescheduled) return;
        expect(result.previous).toMatchObject({ slotId: SLOT.mariaHeld, startUtc: "2026-10-13T18:30:00Z" });
        expect(Appointment.parse(result.appointment)).toEqual({
          ...result.previous,
          providerId: "prov_okafor",
          slotId: SLOT.okaforTue4pm,
          specialty: "dermatology",
          startUtc: "2026-10-13T20:00:00Z",
          endUtc: "2026-10-13T20:30:00Z",
          updatedAt: "2026-10-05T14:00:00.000Z",
        });
        const oldSlot = await repos.slots.get(SLOT.mariaHeld);
        expect(oldSlot).toMatchObject({ status: "OPEN" });
        expect(oldSlot?.appointmentId).toBeUndefined();
        expect(await repos.slots.get(SLOT.okaforTue4pm)).toMatchObject({
          status: "BOOKED",
          appointmentId: APPT.mariaLee,
        });
        expect(await repos.appointments.get(MARIA, APPT.mariaLee)).toEqual(result.appointment);
        // The released slot is open again in both availability queries.
        const open = await repos.slots.listOpenBySpecialtyAndDay("dermatology", "2026-10-13");
        expect(open.map((s) => s.slotId)).toContain(SLOT.mariaHeld);
        expect(open.map((s) => s.slotId)).not.toContain(SLOT.okaforTue4pm);
        await expectConsistent(touched);
      });

      it.each([
        ["the new slot is taken", MARIA, APPT.mariaLee, SLOT.walterHeld, "SLOT_UNAVAILABLE"],
        ["the new slot doesn't exist", MARIA, APPT.mariaLee, SLOT.notSeeded, "SLOT_NOT_FOUND"],
        [
          "it's another patient's appointment",
          WALTER,
          APPT.mariaLee,
          SLOT.leeTue2pm,
          "APPOINTMENT_NOT_FOUND",
        ],
        ["the appointment doesn't exist", MARIA, "appt_0000000999", SLOT.leeTue2pm, "APPOINTMENT_NOT_FOUND"],
        ["the appointment is COMPLETED", WALTER, APPT.walterPast, SLOT.leeTue2pm, "APPOINTMENT_NOT_BOOKED"],
        [
          "the appointment is CANCELLED",
          DANIEL,
          APPT.danielCancelled,
          SLOT.leeTue2pm,
          "APPOINTMENT_NOT_BOOKED",
        ],
      ] as const)(
        "fails when %s, and changes nothing",
        async (_label, patientId, appointmentId, newSlotId, reason) => {
          const patients = [MARIA, WALTER, DANIEL];
          const before = await capture(patients, [...touched, SLOT.danielCancelled]);
          const result = await repos.appointments.reschedule({ patientId, appointmentId, newSlotId });
          expect(result).toEqual({ ok: false, reason });
          expect(await capture(patients, [...touched, SLOT.danielCancelled])).toEqual(before);
        },
      );

      // The status check comes before the same-slot retry answer: a retry into its own slot is not a way
      // to report a CANCELLED or COMPLETED appointment as rescheduled.
      it.each([
        ["CANCELLED", DANIEL, APPT.danielCancelled],
        ["COMPLETED", WALTER, APPT.walterPast],
      ] as const)(
        "fails for a %s appointment moved into the slot it names, and changes nothing",
        async (_status, patientId, appointmentId) => {
          const held = await repos.appointments.get(patientId, appointmentId);
          if (!held) throw new Error(`${appointmentId} is not seeded`);
          const before = await capture([patientId], [held.slotId]);
          const result = await repos.appointments.reschedule({
            patientId,
            appointmentId,
            newSlotId: held.slotId,
          });
          expect(result).toEqual({ ok: false, reason: "APPOINTMENT_NOT_BOOKED" });
          expect(await capture([patientId], [held.slotId])).toEqual(before);
        },
      );

      it("answers a retry into the slot the appointment already holds as success, and changes nothing", async () => {
        const patients = [MARIA];
        const before = await capture(patients, touched);
        const result = await repos.appointments.reschedule({
          patientId: MARIA,
          appointmentId: APPT.mariaLee,
          newSlotId: SLOT.mariaHeld,
        });
        expect(result).toEqual({
          ok: true,
          alreadyRescheduled: true,
          appointment: await repos.appointments.get(MARIA, APPT.mariaLee),
        });
        expect(result.ok && result.appointment).toMatchObject({ slotId: SLOT.mariaHeld, status: "BOOKED" });
        expect(await capture(patients, touched)).toEqual(before);
      });

      it("two patients racing for the same new slot: exactly one moves, the other is untouched", async () => {
        const before = await capture([WALTER], [SLOT.walterHeld]);
        const [maria, walter] = await Promise.all([
          repos.appointments.reschedule({
            patientId: MARIA,
            appointmentId: APPT.mariaLee,
            newSlotId: SLOT.leeTue2pm,
          }),
          repos.appointments.reschedule({
            patientId: WALTER,
            appointmentId: APPT.walterHaddad,
            newSlotId: SLOT.leeTue2pm,
          }),
        ]);
        expect([maria.ok, walter.ok].filter(Boolean)).toHaveLength(1);
        const loser = maria.ok ? walter : maria;
        expect(loser).toEqual({ ok: false, reason: "SLOT_UNAVAILABLE" });
        if (maria.ok) expect(await capture([WALTER], [SLOT.walterHeld])).toEqual(before);
        await expectConsistent(touched);
      });

      it("a booking and a reschedule racing for one slot: exactly one wins", async () => {
        const [booked, moved] = await Promise.all([
          repos.appointments.book({ patientId: AISHA, slotId: SLOT.leeTue3pm, reason: "Skin check" }),
          repos.appointments.reschedule({
            patientId: MARIA,
            appointmentId: APPT.mariaLee,
            newSlotId: SLOT.leeTue3pm,
          }),
        ]);
        expect([booked.ok, moved.ok].filter(Boolean)).toHaveLength(1);
        await expectConsistent([...touched, SLOT.leeTue3pm]);
      });

      it("parallel reschedules of one appointment leave a consistent state", async () => {
        const targets = [SLOT.leeTue2pm, SLOT.leeTue3pm, SLOT.leeTue330pm, SLOT.okaforTue4pm];
        const results = await Promise.all(
          targets.map((newSlotId) =>
            repos.appointments.reschedule({ patientId: MARIA, appointmentId: APPT.mariaLee, newSlotId }),
          ),
        );
        expect(results.some((r) => r.ok)).toBe(true);
        const slots = await Promise.all([SLOT.mariaHeld, ...targets].map((id) => repos.slots.get(id)));
        expect(slots.filter((s) => s?.status === "BOOKED")).toHaveLength(1);
        const appt = await repos.appointments.get(MARIA, APPT.mariaLee);
        expect(slots.find((s) => s?.status === "BOOKED")?.slotId).toBe(appt?.slotId);
        await expectConsistent([SLOT.mariaHeld, ...targets]);
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("conversations (AP-8, append-only)", () => {
      it("appends and reads messages back in seq order, byte-for-byte", async () => {
        const batch = [message(CONV_A, 0), message(CONV_A, 1)];
        await repos.conversations.append(MARIA, batch);
        await repos.conversations.append(MARIA, [message(CONV_A, 2), message(CONV_A, 3)]);
        const read = await repos.conversations.listMessages(MARIA, CONV_A);
        expect(read.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
        expect(read.slice(0, 2)).toEqual(batch); // unknown content-block fields survive
        read.forEach((m) => ConversationMessage.parse(m));
      });

      it("hides a conversation from other patients", async () => {
        await repos.conversations.append(MARIA, [message(CONV_A, 0)]);
        expect(await repos.conversations.listMessages(WALTER, CONV_A)).toEqual([]);
        expect(await repos.conversations.listMessages(MARIA, CONV_B)).toEqual([]);
      });

      it("never overwrites: re-appending an existing seq throws SEQ_CONFLICT and writes nothing", async () => {
        await repos.conversations.append(MARIA, [message(CONV_A, 0), message(CONV_A, 1)]);
        const attempt = repos.conversations.append(MARIA, [message(CONV_A, 1, "edited"), message(CONV_A, 2)]);
        await expect(attempt).rejects.toBeInstanceOf(ConversationAppendError);
        await expect(attempt).rejects.toMatchObject({ code: "SEQ_CONFLICT" });
        const read = await repos.conversations.listMessages(MARIA, CONV_A);
        expect(read.map((m) => m.seq)).toEqual([0, 1]); // seq 2 was not written either
        expect(read[1]).toEqual(message(CONV_A, 1));
      });

      it("rejects restarting an existing conversation at seq 0", async () => {
        await repos.conversations.append(MARIA, [message(CONV_A, 0)]);
        await expect(repos.conversations.append(MARIA, [message(CONV_A, 0, "again")])).rejects.toMatchObject({
          code: "SEQ_CONFLICT",
        });
      });

      it("requires the patient's own predecessor message (no gaps, no appending to someone else's history)", async () => {
        await repos.conversations.append(MARIA, [message(CONV_A, 0), message(CONV_A, 1)]);
        await expect(repos.conversations.append(WALTER, [message(CONV_A, 2)])).rejects.toMatchObject({
          code: "PREDECESSOR_MISSING",
        });
        await expect(repos.conversations.append(MARIA, [message(CONV_A, 5)])).rejects.toMatchObject({
          code: "PREDECESSOR_MISSING",
        });
        await expect(repos.conversations.append(MARIA, [message(CONV_B, 3)])).rejects.toMatchObject({
          code: "PREDECESSOR_MISSING",
        });
        expect((await repos.conversations.listMessages(MARIA, CONV_A)).map((m) => m.seq)).toEqual([0, 1]);
      });

      it("rejects malformed batches before writing", async () => {
        await expect(repos.conversations.append(MARIA, [])).rejects.toThrow(RangeError);
        await expect(
          repos.conversations.append(MARIA, [message(CONV_A, 0), message(CONV_A, 2)]),
        ).rejects.toThrow(RangeError);
        await expect(
          repos.conversations.append(MARIA, [message(CONV_A, 0), message(CONV_B, 1)]),
        ).rejects.toThrow(RangeError);
        expect(await repos.conversations.listMessages(MARIA, CONV_A)).toEqual([]);
      });

      it("two turns racing to append the same seq: exactly one wins", async () => {
        await repos.conversations.append(MARIA, [message(CONV_A, 0)]);
        const results = await Promise.allSettled([
          repos.conversations.append(MARIA, [message(CONV_A, 1, "turn one")]),
          repos.conversations.append(MARIA, [message(CONV_A, 1, "turn two")]),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect((await repos.conversations.listMessages(MARIA, CONV_A)).map((m) => m.seq)).toEqual([0, 1]);
      });

      it("lists a patient's conversations, newest first", async () => {
        await repos.conversations.append(MARIA, [message(CONV_A, 0)]);
        await repos.conversations.append(MARIA, [
          { ...message(CONV_B, 0), createdAt: "2026-10-06T12:00:00.000Z" },
        ]);
        const list = await repos.conversations.listConversations(MARIA);
        expect(list).toEqual([
          { conversationId: CONV_B, patientId: MARIA, createdAt: "2026-10-06T12:00:00.000Z" },
          { conversationId: CONV_A, patientId: MARIA, createdAt: NOW },
        ]);
        expect(await repos.conversations.listConversations(MARIA, { limit: 1 })).toHaveLength(1);
        expect(await repos.conversations.listConversations(WALTER)).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("escalations (AP-9)", () => {
      const input = {
        patientId: MARIA,
        conversationId: CONV_A,
        reason: "patient_requested",
        summary: "Patient asked to speak with a person about rescheduling a dermatology visit.",
      } as const;

      it("records an escalation with an injected id and the clock's time", async () => {
        const result = await repos.escalations.record(input);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.alreadyEscalated).toBe(false);
        const escalation = Escalation.parse(result.escalation);
        expect(ids.issued.has(escalation.escalationId)).toBe(true);
        expect(escalation).toMatchObject({ ...input, createdAt: NOW, notification: { status: "PENDING" } });
        expect(await repos.escalations.getForConversation(MARIA, CONV_A)).toEqual(escalation);
      });

      it("records at most once per conversation, even in parallel", async () => {
        const results = await Promise.all([
          repos.escalations.record(input),
          repos.escalations.record({ ...input, reason: "frustration" }),
          repos.escalations.record(input),
        ]);
        const oks = results.flatMap((r) => (r.ok ? [r] : []));
        expect(oks).toHaveLength(3);
        expect(oks.filter((r) => !r.alreadyEscalated)).toHaveLength(1);
        expect(new Set(oks.map((r) => r.escalation.escalationId)).size).toBe(1);
      });

      it("never shows or reuses another patient's escalation", async () => {
        await repos.escalations.record(input);
        expect(await repos.escalations.getForConversation(WALTER, CONV_A)).toBeNull();
        expect(await repos.escalations.record({ ...input, patientId: WALTER })).toEqual({
          ok: false,
          reason: "NOT_OWNER",
        });
        expect(await repos.escalations.updateNotification(WALTER, CONV_A, { status: "SENT" })).toBeNull();
        expect((await repos.escalations.getForConversation(MARIA, CONV_A))?.notification).toEqual({
          status: "PENDING",
        });
      });

      it("updates the notification status", async () => {
        await repos.escalations.record(input);
        const updated = await repos.escalations.updateNotification(MARIA, CONV_A, {
          status: "SENT",
          messageId: "0100019a-example",
        });
        expect(updated?.notification).toEqual({ status: "SENT", messageId: "0100019a-example" });
        expect(await repos.escalations.getForConversation(MARIA, CONV_A)).toEqual(updated);
        expect(await repos.escalations.updateNotification(MARIA, CONV_B, { status: "SENT" })).toBeNull();
      });
    });

    // -----------------------------------------------------------------------------------------
    describe("isolation", () => {
      it("returns copies: mutating a result doesn't change stored data", async () => {
        const slot = await repos.slots.get(SLOT.leeTue2pm);
        if (slot) slot.status = "BOOKED";
        const appts = await repos.appointments.listForPatient(MARIA);
        if (appts[0]) appts[0].reason = "tampered";
        expect(await repos.slots.get(SLOT.leeTue2pm)).toMatchObject({ status: "OPEN" });
        expect((await repos.appointments.get(MARIA, APPT.mariaLee))?.reason).toBe("Mole check");
      });
    });
  });
}
