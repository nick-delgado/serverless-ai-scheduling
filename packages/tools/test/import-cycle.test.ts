/**
 * The registry imports every handler, so a handler that imports the registry back makes a cycle (#77).
 * Handlers take their types and helpers from `src/handler.ts` instead.
 */
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TOOLS_DIR = new URL("../src/tools/", import.meta.url);
const toolFiles = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"));

/** Every module specifier in an `import … from "…"` or `export … from "…"` statement. */
const specifiersOf = (source: string): string[] =>
  [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map((m) => m[1] ?? "");

describe("handlers don't import the registry", () => {
  it("finds the handler files", () => {
    expect(toolFiles).toEqual(expect.arrayContaining(["book_appointment.ts", "reschedule_appointment.ts"]));
  });

  it.each(toolFiles)("src/tools/%s imports nothing from ../registry", (file) => {
    const source = readFileSync(new URL(file, TOOLS_DIR), "utf8");
    expect(specifiersOf(source)).not.toContain("../registry");
  });
});
