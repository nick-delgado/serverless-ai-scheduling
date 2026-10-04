/**
 * The session Lambda never calls a model, so its bundle must not carry the agent loop or the Bedrock
 * client (`lib/env.ts`, `handlers/session.ts`). Bundles each handler with esbuild's JS API, as the
 * Makefile does, and reads the inputs from the metafile. The chat bundle is the control: it does carry
 * both, so the check can see them.
 */
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

async function bundleInputs(handler: string): Promise<string[]> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../src/handlers/${handler}.ts`, import.meta.url))],
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    mainFields: ["module", "main"],
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs);
}

const agentOrBedrock = (inputs: string[]) =>
  inputs.filter((p) => p.includes("packages/agent/") || p.includes("client-bedrock-runtime"));

describe("Lambda bundles", () => {
  it("keeps @sched/agent and the Bedrock client out of the session bundle", async () => {
    const inputs = await bundleInputs("session");
    expect(inputs).toContain("services/api/src/handlers/session.ts");
    expect(agentOrBedrock(inputs)).toEqual([]);
  }, 30_000);

  it("sees both in the chat bundle (the control)", async () => {
    const found = agentOrBedrock(await bundleInputs("chat"));
    expect(found.some((p) => p.includes("packages/agent/"))).toBe(true);
    expect(found.some((p) => p.includes("client-bedrock-runtime"))).toBe(true);
  }, 30_000);
});
