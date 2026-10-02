/**
 * Scenario lint (#33, replaced by the real schema in #30). Structure is the loader's job: every file must
 * parse and satisfy the Zod schema (`src/schema.ts`), id = file name, category = folder. On top of that,
 * this checks what a schema can't: ids that exist in the `clinic-default` fixture, the ADR-008 budget,
 * and the coverage the scenarios README promises.
 */
import { LIMITS } from "@sched/contracts";
import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import { allStrings, loadScenarios, selectSuite, type L1Case, type Scenario } from "../src";

/** ADR-008 scenario budget (v1). */
const CATEGORY_COUNTS = { book: 8, reschedule: 6, availability: 6, escalate: 5, clarify: 5, safety: 10 };
const REQUIRED_FRS = ["FR-030", "FR-031", "FR-032", "FR-033", "FR-034", "FR-035", "FR-036", "FR-037"];
/** ADR-009 "Agent behavior" + identity lines, as keyed in scenarios/README.md. */
const REQUIRED_POLICIES = [
  "adr9.scope",
  "adr9.no-medical-advice",
  "adr9.emergency",
  "adr9.confirm-before-write",
  "adr9.no-invented-facts",
  "adr9.escalation",
  "adr9.tool-results-are-data",
  "adr9.identity-from-jwt",
];

const { scenarios, l1 } = loadScenarios();
const all: (Scenario | L1Case)[] = [...scenarios, ...l1];

const fixture = buildClinicFixture();
const slotStatus = new Map(fixture.slots.map((s) => [s.slotId, s.status]));
const fixtureAppointmentIds = new Set(fixture.appointments.map((a) => a.appointmentId));
const providerIds = new Set(fixture.providers.map((p) => p.providerId));
const patientUuids = new Set<string>(Object.values(FIXTURE_PATIENT_IDS));
const windowStart = Date.parse(`${fixture.baseDate}T00:00:00Z`);
const windowEnd = windowStart + fixture.weeks * 7 * 86_400_000;

describe("eval scenarios (schema)", () => {
  it("loads and validates every file", () => {
    expect(scenarios.length).toBe(40);
    expect(l1.length).toBeGreaterThanOrEqual(10);
  });

  it("has the ADR-008 budget per category", () => {
    const counts = Object.fromEntries(Object.keys(CATEGORY_COUNTS).map((c) => [c, 0]));
    for (const s of scenarios) counts[s.category] = (counts[s.category] ?? 0) + 1;
    expect(counts).toEqual(CATEGORY_COUNTS);
  });

  it("tags a smoke suite of about 8 multi-turn scenarios", () => {
    const smoke = selectSuite(scenarios, "smoke").length;
    expect(smoke).toBeGreaterThanOrEqual(6);
    expect(smoke).toBeLessThanOrEqual(10);
  });

  it.each(all.map((s) => [s.id, s] as const))("%s: clock inside the fixture window", (_id, s) => {
    const clock = Date.parse(s.clock);
    expect(clock >= windowStart && clock < windowEnd).toBe(true);
  });
});

describe("eval scenarios (fixture references)", () => {
  it.each(all.map((s) => [s.id, s] as const))("%s: ids exist in clinic-default", (_id, s) => {
    const extra = s.setup?.appointments ?? [];
    const declared = new Set<string>([
      ...("fabricated_ids" in s ? (s.fabricated_ids ?? []) : []),
      ...extra.map((a) => a.appointment_id),
      ...(s.setup?.conversations ?? []).map((c) => c.conversation_id),
    ]);

    for (const a of extra) {
      expect(slotStatus.get(a.slot_id), `${a.slot_id} must be an OPEN fixture slot`).toBe("OPEN");
      expect(a.reason.length).toBeLessThanOrEqual(LIMITS.reasonMaxChars);
    }

    for (const text of allStrings(s)) {
      for (const [id] of text.matchAll(/\bprov_[a-z]+\b/g)) expect(providerIds, text).toContain(id);
      for (const [id] of text.matchAll(/\bslot_[a-z]+_\d{8}T\d{4}Z\b/g))
        if (!declared.has(id)) expect(slotStatus.has(id), `unknown slot ${id}`).toBe(true);
      for (const [id] of text.matchAll(/\bappt_[0-9A-Za-z]{10,40}\b/g))
        if (!declared.has(id)) expect(fixtureAppointmentIds, `unknown appointment ${id}`).toContain(id);
      for (const [id] of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g))
        if (!declared.has(id)) expect(patientUuids, `unknown UUID ${id}`).toContain(id);
    }
  });
});

describe("eval scenarios (coverage)", () => {
  const covered = new Set(all.flatMap((s) => s.covers));

  it("covers every FR-030…FR-037", () => {
    expect(REQUIRED_FRS.filter((fr) => !covered.has(fr))).toEqual([]);
  });

  it("covers every ADR-009 agent-behavior policy line", () => {
    expect(REQUIRED_POLICIES.filter((p) => !covered.has(p))).toEqual([]);
  });

  it("includes the required red-team cases", () => {
    const safetyTags = new Set(scenarios.filter((s) => s.category === "safety").flatMap((s) => s.tags));
    for (const tag of [
      "direct-injection",
      "indirect-injection",
      "tool-result-injection",
      "privacy",
      "conversation-ownership",
      "fake-system",
      "medical-advice",
      "emergency",
      "off-topic",
      "abuse",
      "booking-without-confirmation",
    ])
      expect(safetyTags, tag).toContain(tag);
  });

  it("includes scenarios after the Nov 1 DST change", () => {
    expect(scenarios.filter((s) => s.tags.includes("dst")).length).toBeGreaterThanOrEqual(2);
  });
});
