import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CheckAvailabilityInput,
  DateRange,
  GetPatientProfileInput,
  TOOL_NAMES,
  TOOLS,
  toolDefinitionsForModel,
  toolInputJsonSchema,
  type ToolName,
} from "./tools";
import { EXAMPLES } from "./testing/examples";

const INPUT_EXAMPLES: Record<ToolName, unknown> = {
  find_providers: EXAMPLES.FindProvidersInput,
  check_availability: EXAMPLES.CheckAvailabilityInput,
  get_my_appointments: EXAMPLES.GetMyAppointmentsInput,
  get_patient_profile: EXAMPLES.GetPatientProfileInput,
  book_appointment: EXAMPLES.BookAppointmentInput,
  reschedule_appointment: EXAMPLES.RescheduleAppointmentInput,
  escalate_to_human: EXAMPLES.EscalateToHumanInput,
};

/** Every property name anywhere in a JSON Schema (walks nested objects, arrays, and combinators). */
function propertyNames(schema: unknown, found: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const s of schema) propertyNames(s, found);
  } else if (schema && typeof schema === "object") {
    const obj = schema as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === "object") {
      for (const [key, sub] of Object.entries(obj.properties)) {
        found.push(key);
        propertyNames(sub, found);
      }
    }
    for (const [key, value] of Object.entries(obj)) if (key !== "properties") propertyNames(value, found);
  }
  return found;
}

describe("tool registry", () => {
  it("defines every tool name exactly once, in a stable order", () => {
    expect(Object.keys(TOOLS).sort()).toEqual([...TOOL_NAMES].sort());
    expect(toolDefinitionsForModel().map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it("produces byte-identical definitions on every call (keeps the prompt cache warm)", () => {
    expect(JSON.stringify(toolDefinitionsForModel())).toBe(JSON.stringify(toolDefinitionsForModel()));
  });

  it.each(TOOL_NAMES)("%s has a substantive model-facing description", (name) => {
    expect(TOOLS[name].description.length).toBeGreaterThan(80);
  });

  // The add-agent-tool guideline "what it returns, and which fields to quote verbatim", as a check.
  const returnsStartLocal = TOOL_NAMES.filter((name) =>
    JSON.stringify(z.toJSONSchema(TOOLS[name].output)).includes('"start_local"'),
  );
  it("finds the tools whose output carries start_local", () => {
    expect(returnsStartLocal.length).toBeGreaterThan(0);
  });
  it.each(returnsStartLocal)("%s tells the model to quote start_local", (name) => {
    expect(TOOLS[name].description).toMatch(/start_local/);
  });

  it("matches the committed snapshot (model-facing changes show up in PR diffs)", () => {
    expect(toolDefinitionsForModel()).toMatchSnapshot();
  });
});

describe("security invariant: no patient identity in tool inputs (CLAUDE.md rule 1)", () => {
  it.each(TOOL_NAMES)("%s input schema has no patient/user identifier property", (name) => {
    const offending = propertyNames(toolInputJsonSchema(name)).filter((key) =>
      /patient|user_?id|member|subject|\bsub\b/i.test(key),
    );
    expect(offending).toEqual([]);
  });

  it.each(TOOL_NAMES)("%s rejects a smuggled patient_id at runtime (strict input)", (name) => {
    const tampered = { ...(INPUT_EXAMPLES[name] as object), patient_id: "someone-else" };
    expect(TOOLS[name].input.safeParse(tampered).success).toBe(false);
  });

  it.each(TOOL_NAMES)("%s input JSON schema forbids additional properties", (name) => {
    expect(toolInputJsonSchema(name)).toMatchObject({ type: "object", additionalProperties: false });
  });
});

describe("model-facing schema shape", () => {
  it("does not emit $schema (not part of the Converse toolSpec shape)", () => {
    for (const def of toolDefinitionsForModel()) expect(def.inputSchema).not.toHaveProperty("$schema");
  });

  it("shows defaulted fields as optional to the model", () => {
    const schema = toolInputJsonSchema("check_availability") as { required?: string[] };
    expect(schema.required).toEqual(["date_range"]);
    expect((toolInputJsonSchema("get_my_appointments") as { required?: string[] }).required ?? []).toEqual(
      [],
    );
  });

  it("keeps date patterns short (tool schemas are sent on every request)", () => {
    const json = JSON.stringify(toolInputJsonSchema("check_availability"));
    const patterns = [...json.matchAll(/"pattern":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) expect(p.length).toBeLessThan(40);
  });

  it("keeps the whole tools array compact", () => {
    expect(JSON.stringify(toolDefinitionsForModel()).length).toBeLessThan(8000);
  });
});

describe("input validation rules", () => {
  it("fills time_of_day with 'any' when omitted", () => {
    const parsed = CheckAvailabilityInput.parse({
      date_range: { start_date: "2026-10-13", end_date: "2026-10-14" },
    });
    expect(parsed.time_of_day).toBe("any");
  });

  it("rejects a date range that ends before it starts", () => {
    expect(DateRange.safeParse({ start_date: "2026-10-14", end_date: "2026-10-13" }).success).toBe(false);
  });

  it("allows up to 31 days and rejects longer ranges", () => {
    expect(DateRange.safeParse({ start_date: "2026-10-01", end_date: "2026-10-31" }).success).toBe(true);
    expect(DateRange.safeParse({ start_date: "2026-10-01", end_date: "2026-11-01" }).success).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    expect(DateRange.safeParse({ start_date: "2026-02-30", end_date: "2026-03-01" }).success).toBe(false);
  });

  it("get_patient_profile takes no arguments at all", () => {
    expect(GetPatientProfileInput.safeParse({}).success).toBe(true);
    expect(GetPatientProfileInput.safeParse({ include_past: true }).success).toBe(false);
  });

  it("book_appointment requires a well-formed slot_id and a reason", () => {
    expect(TOOLS.book_appointment.input.safeParse({ slot_id: "tuesday 2:30", reason: "Mole" }).success).toBe(
      false,
    );
    expect(TOOLS.book_appointment.input.safeParse({ slot_id: EXAMPLES.SlotId, reason: "   " }).success).toBe(
      false,
    );
  });
});
