/**
 * Structural lint for the eval scenarios (#33). Deliberately small: the real scenario schema and loader come
 * with the harness (S7-01, #30). This only guarantees that every file parses, has the fields the README
 * documents, points at ids that exist in the `clinic-default` fixture, and that the coverage promised in
 * the README holds.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS, TOOL_NAMES, TOOLS, ToolError, type ToolName } from "@sched/contracts";
import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "scenarios");

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
const TOOL_LIST_KEYS = new Set([
  "forbid_tools",
  "must_call_before",
  "must_confirm_before",
  "must_ask_before",
]);

type Doc = Record<string, unknown>;
interface ScenarioFile {
  path: string;
  dir: string;
  doc: Doc;
}

const isRecord = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isToolName = (v: unknown): v is ToolName => typeof v === "string" && TOOL_NAMES.includes(v as ToolName);

function loadAll(): ScenarioFile[] {
  const files: ScenarioFile[] = [];
  for (const dir of readdirSync(SCENARIOS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(SCENARIOS_DIR, dir.name))) {
      if (!f.endsWith(".yaml")) continue;
      const path = join(SCENARIOS_DIR, dir.name, f);
      const doc: unknown = parse(readFileSync(path, "utf8"));
      if (!isRecord(doc)) throw new Error(`${path}: top level must be a mapping`);
      files.push({ path: relative(SCENARIOS_DIR, path), dir: dir.name, doc });
    }
  }
  return files;
}

/** Every string anywhere in the document (values and keys). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isRecord(v))
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out);
    }
  return out;
}

/** Tool names referenced by trajectory/expect keys. */
function toolRefs(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) for (const x of v) toolRefs(x, out);
  else if (isRecord(v))
    for (const [k, x] of Object.entries(v)) {
      if (k === "tool") out.push(x);
      else if (TOOL_LIST_KEYS.has(k)) out.push(...(x === "all" ? [] : Array.isArray(x) ? x : [x]));
      else if (k === "max_calls" && isRecord(x)) out.push(...Object.keys(x));
      toolRefs(x, out);
    }
  return out;
}

const fixture = buildClinicFixture();
const slotStatus = new Map(fixture.slots.map((s) => [s.slotId, s.status]));
const fixtureAppointmentIds = new Set(fixture.appointments.map((a) => a.appointmentId));
const providerIds = new Set(fixture.providers.map((p) => p.providerId));
const patientUuids = new Set<string>(Object.values(FIXTURE_PATIENT_IDS));
const windowStart = Date.parse(`${fixture.baseDate}T00:00:00Z`);
const windowEnd = windowStart + fixture.weeks * 7 * 86_400_000;

const all = loadAll();
const scenarios = all.filter((s) => s.dir !== "l1");
const l1 = all.filter((s) => s.dir === "l1");

describe("eval scenarios (structure)", () => {
  it("has the ADR-008 budget per category, plus L1 cases", () => {
    const counts = Object.fromEntries(Object.keys(CATEGORY_COUNTS).map((c) => [c, 0]));
    for (const s of scenarios) counts[s.dir] = (counts[s.dir] ?? 0) + 1;
    expect(counts).toEqual(CATEGORY_COUNTS);
    expect(l1.length).toBeGreaterThanOrEqual(10);
  });

  it("tags a smoke suite of about 8 multi-turn scenarios", () => {
    const smoke = scenarios.filter((s) => asArray(s.doc.tags).includes("smoke")).length;
    expect(smoke).toBeGreaterThanOrEqual(6);
    expect(smoke).toBeLessThanOrEqual(10);
  });

  it("has unique ids that match file name and folder", () => {
    const ids = all.map((s) => s.doc.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of all) {
      expect(s.doc.id, s.path).toBe(basename(s.path, ".yaml"));
      expect(s.doc.category, s.path).toBe(s.dir);
    }
  });

  it.each(all.map((s) => [s.path, s] as const))("%s: common fields", (_path, { doc }) => {
    expect(doc.fixture).toBe("clinic-default");
    expect(typeof doc.clock === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(doc.clock)).toBe(true);
    const clock = Date.parse(String(doc.clock));
    expect(clock >= windowStart && clock < windowEnd, "clock inside the fixture window").toBe(true);
    expect(Object.keys(FIXTURE_PATIENT_IDS)).toContain(doc.patient);
    expect(Array.isArray(doc.tags)).toBe(true);
    expect(asArray(doc.covers).length).toBeGreaterThan(0);
    expect(isRecord(doc.expect)).toBe(true);
    for (const tool of toolRefs(doc.expect))
      expect(TOOL_NAMES, `unknown tool ${String(tool)}`).toContain(tool);
  });

  it.each(scenarios.map((s) => [s.path, s] as const))("%s: multi-turn fields", (_path, { doc }) => {
    for (const k of ["persona", "goal"]) expect(typeof doc[k] === "string" && doc[k] !== "", k).toBe(true);
    expect(Number.isInteger(doc.max_turns) && Number(doc.max_turns) > 0).toBe(true);
    expect(doc.hidden_facts === undefined || isRecord(doc.hidden_facts)).toBe(true);
    const ex = doc.expect as Doc;
    expect(isRecord(ex.end_state), "expect.end_state").toBe(true);
    for (const k of ["trajectory", "invariants", "judge"])
      expect(Array.isArray(ex[k]), `expect.${k}`).toBe(true);
  });

  it.each(l1.map((s) => [s.path, s] as const))("%s: L1 context and expectation", (_path, { doc }) => {
    const context = asArray(doc.context);
    expect(context.length).toBeGreaterThan(0);
    for (const step of context) {
      expect(isRecord(step)).toBe(true);
      const s = step as Doc;
      const [kind] = Object.keys(s);
      expect(["patient", "assistant", "tool_call", "tool_result"]).toContain(kind);
      if (kind === "tool_call" || kind === "tool_result") {
        const body = s[kind] as Doc;
        if (!isToolName(body.tool)) throw new Error(`unknown tool ${String(body.tool)}`);
        const contract = TOOLS[body.tool];
        if (kind === "tool_call") contract.input.parse(body.args);
        else if (body.error !== undefined) ToolError.parse({ error: body.error });
        else contract.output.parse(body.result);
      }
    }
    const ex = doc.expect as Doc;
    const options = ex.any_of === undefined ? [ex] : asArray(ex.any_of);
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      const opt = o as Doc;
      expect(["tool_call", "respond"]).toContain(opt.action);
      if (opt.action === "tool_call") expect(TOOL_NAMES).toContain(opt.tool);
    }
  });
});

describe("eval scenarios (fixture references)", () => {
  it.each(all.map((s) => [s.path, s] as const))("%s: ids exist in clinic-default", (_path, { doc }) => {
    const setup = isRecord(doc.setup) ? doc.setup : {};
    const extraAppointments = asArray(setup.appointments).filter(isRecord);
    const declared = new Set<string>([
      ...asArray(doc.fabricated_ids).map(String),
      ...extraAppointments.map((a) => String(a.appointment_id)),
      ...asArray(setup.conversations)
        .filter(isRecord)
        .map((c) => String(c.conversation_id)),
    ]);

    for (const a of extraAppointments) {
      expect(slotStatus.get(String(a.slot_id)), `${String(a.slot_id)} must be an OPEN fixture slot`).toBe(
        "OPEN",
      );
      expect(Object.keys(FIXTURE_PATIENT_IDS)).toContain(a.patient);
      expect(String(a.reason).length).toBeLessThanOrEqual(LIMITS.reasonMaxChars);
    }

    for (const text of strings(doc)) {
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
  const covered = new Set(all.flatMap((s) => asArray(s.doc.covers).map(String)));

  it("covers every FR-030…FR-037", () => {
    expect(REQUIRED_FRS.filter((fr) => !covered.has(fr))).toEqual([]);
  });

  it("covers every ADR-009 agent-behavior policy line", () => {
    expect(REQUIRED_POLICIES.filter((p) => !covered.has(p))).toEqual([]);
  });

  it("includes the required red-team cases", () => {
    const safetyTags = new Set(all.filter((s) => s.dir === "safety").flatMap((s) => asArray(s.doc.tags)));
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
    expect(scenarios.filter((s) => asArray(s.doc.tags).includes("dst")).length).toBeGreaterThanOrEqual(2);
  });
});
