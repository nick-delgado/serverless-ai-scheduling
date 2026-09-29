import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as C from "./index";
import { EXAMPLES } from "./testing/examples";

const exportedSchemas = (Object.entries(C) as [string, unknown][]).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
);

describe("schema coverage", () => {
  it("exports a meaningful number of schemas", () => {
    expect(exportedSchemas.length).toBeGreaterThan(40);
  });

  it("has an example for every exported schema (keeps round-trip coverage at 100%)", () => {
    const missing = exportedSchemas.map(([name]) => name).filter((name) => !(name in EXAMPLES));
    expect(missing).toEqual([]);
  });

  it("has no examples for schemas that no longer exist", () => {
    const names = new Set(exportedSchemas.map(([name]) => name));
    expect(Object.keys(EXAMPLES).filter((name) => !names.has(name))).toEqual([]);
  });
});

describe.each(exportedSchemas)("%s", (name, schema) => {
  const example = (EXAMPLES as Record<string, unknown>)[name];

  it("accepts its example", () => {
    const result = schema.safeParse(example);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it("round-trips through JSON unchanged", () => {
    const once = schema.parse(example);
    const twice = schema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});
