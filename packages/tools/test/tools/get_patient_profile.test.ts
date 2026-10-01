import { TOOLS, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import {
  createToolExecutor,
  TOOL_REGISTRY,
  type ToolContext,
  type ToolExecutionResult,
} from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import { getPatientProfile } from "../../src/tools/get_patient_profile";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const AISHA = FIXTURE_PATIENT_IDS["pat-aisha"]; // no preferred provider
const UNKNOWN = "0b3c5d7e-1f2a-4b6c-8d9e-0a1b2c3d4e5f"; // valid v4 UUID, not in the fixture

const outputOf = (r: ToolExecutionResult): ToolOutput<"get_patient_profile"> => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return TOOLS.get_patient_profile.output.parse(r.output);
};
const errorOf = (r: ToolExecutionResult): ToolError["error"] => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error.error;
};

describe("get_patient_profile", () => {
  let repos: InMemoryRepositories;
  let clock: FrozenClock;

  const contextFor = (patientId: string): ToolContext => ({
    patientId,
    conversationId: EXAMPLES.ConversationId,
    clock,
    repos,
  });
  // Through the executor, so the strict input schema and output validation the model faces apply.
  const run = (patientId: string, input: unknown = {}): Promise<ToolExecutionResult> =>
    createToolExecutor({ get_patient_profile: getPatientProfile }, contextFor(patientId)).execute({
      id: "toolu_test",
      name: "get_patient_profile",
      input,
    });

  beforeEach(() => {
    const fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow);
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("is registered in TOOL_REGISTRY, so the model is offered it and calls reach this handler", async () => {
    const executor = createToolExecutor(TOOL_REGISTRY, contextFor(MARIA));
    expect(executor.definitions.map((d) => d.name)).toContain("get_patient_profile");
    const result = await executor.execute({ id: "toolu_test", name: "get_patient_profile", input: {} });
    expect(outputOf(result)).toMatchObject({ first_name: "Maria", last_name: "Santos" });
  });

  it("returns the logged-in patient's name and preferred provider, and nothing else", async () => {
    const result = await run(MARIA);
    expect(outputOf(result)).toEqual({
      first_name: "Maria",
      last_name: "Santos",
      preferred_provider: {
        provider_id: "prov_lee",
        display_name: "Dr. Priya Lee",
        specialty: "dermatology",
        accepting_new_patients: true,
      },
    });
    // No extra PII (ADR-009): the date of birth and patient ID never reach the model.
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("1988-04-17");
    expect(raw).not.toContain(MARIA);
  });

  it("returns preferred_provider: null when the patient has none", async () => {
    expect(outputOf(await run(AISHA))).toEqual({
      first_name: "Aisha",
      last_name: "Rahman",
      preferred_provider: null,
    });
  });

  it("degrades to preferred_provider: null when the preferred provider no longer exists", async () => {
    const seed = buildClinicFixture();
    seed.providers = seed.providers.filter((p) => p.providerId !== "prov_lee");
    seed.slots = seed.slots.filter((s) => s.providerId !== "prov_lee");
    seed.appointments = seed.appointments.filter((a) => a.providerId !== "prov_lee");
    repos = createInMemoryRepositories({ seed, clock, ids: sequentialIds() });
    expect(outputOf(await run(MARIA))).toEqual({
      first_name: "Maria",
      last_name: "Santos",
      preferred_provider: null,
    });
  });

  it("answers NOT_FOUND with a hint when the patient has no profile", async () => {
    const error = errorOf(await run(UNKNOWN));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toBeDefined();
  });

  it("rejects any input field, including a model-supplied patient_id", async () => {
    expect(errorOf(await run(MARIA, { patient_id: WALTER })).code).toBe("INVALID_INPUT");
    expect(errorOf(await run(MARIA, { include_past: true })).code).toBe("INVALID_INPUT");
  });

  it("only ever reads the context patient (cross-patient attempt), and writes nothing", async () => {
    const before = repos.snapshot();
    // Asking for Maria while logged in as Walter is rejected, never answered with her data...
    expect(errorOf(await run(WALTER, { patient_id: MARIA })).code).toBe("INVALID_INPUT");
    // ...and Walter's context only ever yields Walter.
    expect(outputOf(await run(WALTER))).toMatchObject({
      first_name: "Walter",
      last_name: "Haines",
      preferred_provider: { provider_id: "prov_haddad" },
    });
    expect(repos.snapshot()).toEqual(before);
  });
});
