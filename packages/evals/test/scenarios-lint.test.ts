/**
 * Scenario lint (#33, replaced by the real schema in #30). Structure is the loader's job: every file must
 * parse and satisfy the Zod schema (`src/schema.ts`), id = file name, category = folder. On top of that,
 * this checks what a schema can't: ids that exist in the `clinic-default` fixture, the ADR-008 budget,
 * the coverage the scenarios README promises (and that its FR-030…FR-037 and ADR-009 rows name, as a code span, every
 * L1 case whose `covers` has that key; #287, B11-6), and that an L1 case whose context ends with a successful
 * write result expects the reply to quote that result's `start_local` in full (#216, decision #202
 * `779e407/SPEC-1`), and that an L1 case uses the safety-counted text checks (`response.must_not_contain`,
 * `response.must_match_none`) only when its `covers` has an `adr9.*` key, so a format or over-refusal marker
 * goes in a non-safety `format_*` check instead (#282, r1/Q-3 (a)). It also warns, without failing, about judge dimensions
 * that have no rubric yet and so report `skip` (#32, drift-audit decision 13).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS, TOOLS } from "@sched/contracts";
import { confirmedFor } from "@sched/contracts/testing";
import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import {
  allStrings,
  CONVERSATION_OWNERSHIP_TEST,
  isWriteTool,
  loadScenarios,
  SCENARIOS_DIR,
  selectSuite,
  unrubricedInUse,
  type L1Case,
  type Scenario,
} from "../src";

/** ADR-008 scenario budget (v1). */
const CATEGORY_COUNTS = { book: 8, reschedule: 6, availability: 6, escalate: 5, clarify: 5, safety: 11 };
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
    expect(scenarios.length).toBe(41);
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

  /** The README's coverage rows: the L1 cell's code spans (FR rows), or the "Covered by" cell's (ADR-009 rows), by key. */
  const readmeRows = new Map<string, Set<string>>();
  for (const line of readFileSync(join(SCENARIOS_DIR, "README.md"), "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const key = /^FR-\d+/.exec(cells[1] ?? "")?.[0] ?? /^`(adr9\.[\w-]+)`$/.exec(cells[2] ?? "")?.[1];
    if (line.startsWith("| ") && key !== undefined)
      readmeRows.set(key, new Set([...(cells[3] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)));
  }
  /** Each `<key>: <case>` pair where an L1 case covers the key and the key's README row doesn't name it. */
  const unnamed = (keys: readonly string[]) =>
    keys.flatMap((key) =>
      l1
        .filter((c) => c.covers.includes(key) && !readmeRows.get(key)?.has(c.id))
        .map((c) => `${key}: ${c.id}`),
    );

  it("names in each FR-030…FR-037 row of the README every L1 case that covers that FR", () => {
    expect(unnamed(REQUIRED_FRS)).toEqual([]);
  });

  it("names in each ADR-009 policy row of the README every L1 case that covers that policy", () => {
    expect(unnamed(REQUIRED_POLICIES)).toEqual([]);
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

describe("eval scenarios (confirmed slot in context write calls, #313)", () => {
  /** Each `book_appointment` or `reschedule_appointment` call in an L1 context, with its case id (r1/A-1). */
  const writeCalls = l1.flatMap((c) =>
    c.context.flatMap((turn, i) => {
      if (!("tool_call" in turn) || !isWriteTool(turn.tool_call.tool)) return [];
      const args = turn.tool_call.args as Record<string, unknown>;
      const slotId = String(args.slot_id ?? args.new_slot_id);
      return [[`${c.id} context.${i}`, args, slotId] as const];
    }),
  );

  it("finds the write calls in L1 contexts", () => {
    expect(writeCalls.map(([where]) => where)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^l1-reschedule-same-slot-retry /)]),
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(10);
  });

  it.each(writeCalls)("%s: confirmed_* match the call's own slot", (_where, args, slotId) => {
    const { confirmed_provider_id, confirmed_date, confirmed_time } = args;
    expect({ confirmed_provider_id, confirmed_date, confirmed_time }).toEqual(confirmedFor(slotId));
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

describe("eval scenarios (safety-counted text checks, #282)", () => {
  /** The L1 response keys that count as a safety violation (ADR-008, "What counts as a safety violation"). */
  const SAFETY_TEXT_CHECKS = ["must_not_contain", "must_match_none"] as const;
  /** Each `<case>: response.<check>` where an L1 case uses a safety-counted text check and covers no `adr9.*` key. */
  const unsafe = (cases: readonly L1Case[]) =>
    cases
      .filter((c) => !c.covers.some((k) => k.startsWith("adr9.")))
      .flatMap((c) =>
        SAFETY_TEXT_CHECKS.filter((k) => c.expect.response?.[k] !== undefined).map(
          (k) => `${c.id}: response.${k}`,
        ),
      );

  it("uses a safety-counted text check only in an L1 case that covers an adr9.* key (r1/Q-3 (a))", () => {
    expect(
      unsafe(l1),
      "move a format or over-refusal marker to format_must_not_contain or format_must_match_none",
    ).toEqual([]);
  });

  it("flags l1-offer-single-day with its must_match_none put back as a safety check, naming the case and check (TEST-1)", () => {
    const c = l1.find((x) => x.id === "l1-offer-single-day");
    if (c?.expect.response === undefined) throw new Error("l1-offer-single-day has no response checks");
    const { format_must_match_none, ...rest } = c.expect.response;
    const restored = {
      ...c,
      expect: { ...c.expect, response: { ...rest, must_match_none: format_must_match_none } },
    };
    expect(unsafe([restored])).toEqual(["l1-offer-single-day: response.must_match_none"]);
  });

  it("accepts the adr9 cases that keep their text checks as safety", () => {
    const kept = [
      "l1-other-patient-asks-first",
      "l1-patient-id-injection",
      "l1-medical-advice-decline",
      "l1-off-topic-decline",
    ];
    const cases = l1.filter((c) => kept.includes(c.id));
    expect(cases.map((c) => c.id).sort()).toEqual([...kept].sort());
    expect(unsafe(cases)).toEqual([]);
    const medical = cases.find((c) => c.id === "l1-medical-advice-decline");
    expect(medical?.covers).toEqual(["FR-036", "adr9.no-medical-advice"]);
    expect(medical?.expect.response?.must_match_none).toBeDefined();
  });
});

describe("eval scenarios (judge rubrics)", () => {
  it("warns, without failing, about each judge dimension that has no rubric (#32)", () => {
    for (const { dimension, scenarioIds } of unrubricedInUse(scenarios))
      console.warn(
        `scenario lint: judge dimension "${dimension}" has no rubric and reports skip (${scenarioIds.join(", ")})`,
      );
  });
});
