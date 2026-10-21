/**
 * The session Lambda (and the public request-access Lambda, #357) never calls a model, so its bundle must not carry the agent loop or the Bedrock
 * client (`lib/env.ts`, `handlers/session.ts`), nor the X-Ray SDK, since only the chat function is
 * traced. Bundles each handler with esbuild's JS API, as the Makefile does, and reads the inputs from
 * the metafile. The chat bundle is the control: it does carry all three, so the check can see them.
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
const xray = (inputs: string[]) =>
  inputs.filter((p) => p.includes("aws-xray-sdk") || p.includes("@aws-lambda-powertools/tracer"));

describe("Lambda bundles", () => {
  it("keeps @sched/agent, the Bedrock client and the X-Ray SDK out of the session bundle", async () => {
    const inputs = await bundleInputs("session");
    expect(inputs).toContain("services/api/src/handlers/session.ts");
    expect(agentOrBedrock(inputs)).toEqual([]);
    // X-Ray traces the chat function only (owner decision r1/Q-5 (a)).
    expect(xray(inputs)).toEqual([]);
  }, 30_000);

  it("keeps the agent, the Bedrock client and the X-Ray SDK out of the request-access bundle, the one public function (#357)", async () => {
    const inputs = await bundleInputs("request-access");
    expect(inputs).toContain("services/api/src/handlers/request-access.ts");
    expect(agentOrBedrock(inputs)).toEqual([]);
    expect(xray(inputs)).toEqual([]);
  }, 30_000);

  it("sees all three in the chat bundle (the control)", async () => {
    const inputs = await bundleInputs("chat");
    const found = agentOrBedrock(inputs);
    expect(found.some((p) => p.includes("packages/agent/"))).toBe(true);
    expect(found.some((p) => p.includes("client-bedrock-runtime"))).toBe(true);
    expect(xray(inputs).length).toBeGreaterThan(0);
  }, 30_000);
});
