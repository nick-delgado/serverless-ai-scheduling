/**
 * Scenario lint (#33, replaced by the real schema in #30). Structure is the loader's job: every file must
 * parse and satisfy the Zod schema (`src/schema.ts`), id = file name, category = folder. On top of that,
 * this checks what a schema can't: ids that exist in the `clinic-default` fixture, the ADR-008 budget,
 * the coverage the scenarios README promises, and that an L1 case whose context ends with a successful
 * write result expects the reply to quote that result's `start_local` in full (#216, decision #202
 * `779e407/SPEC-1`). It also warns, without failing, about judge dimensions
 * that have no rubric yet and so report `skip` (#32, drift-audit decision 13).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS, TOOLS } from "@sched/contracts";
import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import {
  allStrings,
  CONVERSATION_OWNERSHIP_TEST,
  isWriteTool,
  loadScenarios,
  selectSuite,
  unrubricedInUse,
  type L1Case,
  type Scenario,
} from "../src";

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

describe("eval scenarios (covered outside the harness)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const covered = scenarios.flatMap((s) =>
    s.covered_by === undefined ? [] : [[s.id, s.covered_by] as const],
  );

  it("retires the conversation-ownership case to the chat handler's tests, the invariant's path (#80)", () => {
    expect(covered).toEqual([["safety-conversation-id-ownership", "services/api/test/chat-turn.test.ts"]]);
    expect(CONVERSATION_OWNERSHIP_TEST).toBe("services/api/test/chat-turn.test.ts");
  });

  it.each(covered)("%s: covered_by names a file in the repo", (_id, path) => {
    expect(existsSync(join(repoRoot, path)), path).toBe(true);
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

describe("eval scenarios (write confirmations)", () => {
  /**
   * L1 cases whose context ends with a successful `book_appointment` or `reschedule_appointment` result,
   * so the model's next reply is the write confirmation (#216 r1/Q-1 (b)), each with that result's
   * `appointment.start_local` (the schema has already checked the result against the tool's contract).
   */
  const confirmations = l1.flatMap((c) => {
    const last = c.context.at(-1);
    if (last === undefined || !("tool_result" in last) || !("result" in last.tool_result)) return [];
    const { tool, result } = last.tool_result;
    if (!isWriteTool(tool)) return [];
    return [[c.id, c, TOOLS[tool].output.parse(result).appointment.start_local] as const];
  });

  it("selects the cases whose context ends with a successful write result", () => {
    expect(confirmations.map(([id]) => id)).toEqual(
      expect.arrayContaining(["l1-book-already-booked-confirms", "l1-reschedule-same-slot-retry"]),
    );
  });

  it.each(confirmations)(
    "%s: the reply must quote the write result's start_local in full (#202 779e407/SPEC-1)",
    (_id, c, startLocal) => {
      expect(c.expect.response?.contains_all ?? []).toContain(startLocal);
    },
  );
});

describe("eval scenarios (judge rubrics)", () => {
  it("warns, without failing, about each judge dimension that has no rubric (#32)", () => {
    for (const { dimension, scenarioIds } of unrubricedInUse(scenarios))
      console.warn(
        `scenario lint: judge dimension "${dimension}" has no rubric and reports skip (${scenarioIds.join(", ")})`,
      );
  });
});
