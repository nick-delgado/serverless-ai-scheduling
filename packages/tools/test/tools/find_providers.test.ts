import { LIMITS, TOOLS, type Provider, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS, type ClinicFixture } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import { createToolExecutor, type ToolContext, type ToolExecutionResult } from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import { findProviders } from "../../src/tools/find_providers";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];

const outputOf = (r: ToolExecutionResult): ToolOutput<"find_providers"> => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return TOOLS.find_providers.output.parse(r.output);
};
const errorOf = (r: ToolExecutionResult): ToolError["error"] => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error.error;
};
const idsOf = (r: ToolExecutionResult): string[] => outputOf(r).providers.map((p) => p.provider_id);

describe("find_providers", () => {
  let fixture: ClinicFixture;
  let repos: InMemoryRepositories;
  let clock: FrozenClock;

  const run = (input: unknown = {}, patientId: string = MARIA): Promise<ToolExecutionResult> => {
    const ctx: ToolContext = { patientId, conversationId: EXAMPLES.ConversationId, clock, repos };
    return createToolExecutor({ find_providers: findProviders }, ctx).execute({
      id: "toolu_test",
      name: "find_providers",
      input,
    });
  };

  beforeEach(() => {
    fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow);
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("lists every provider in a stable order (specialty, then last name) with no filter", async () => {
    expect(idsOf(await run())).toEqual([
      "prov_haddad",
      "prov_lee",
      "prov_okafor",
      "prov_alvarez",
      "prov_brooks",
      "prov_chen",
      "prov_nakamura",
      "prov_kowalski",
    ]);
    // Same question, same answer.
    expect(idsOf(await run())).toEqual(idsOf(await run()));
  });

  it("resolves a name as the patient says it into the exact summary", async () => {
    const lee = {
      provider_id: "prov_lee",
      display_name: "Dr. Priya Lee",
      specialty: "dermatology",
      accepting_new_patients: true,
    };
    expect(outputOf(await run({ name_query: "Dr. Lee" }))).toEqual({ providers: [lee] });
    expect(outputOf(await run({ name_query: "lee" }))).toEqual({ providers: [lee] });
    expect(outputOf(await run({ name_query: "priya lee" }))).toEqual({ providers: [lee] });
    expect(idsOf(await run({ name_query: "Okafor" }))).toEqual(["prov_okafor"]);
    expect(idsOf(await run({ name_query: "  doctor OKAFOR " }))).toEqual(["prov_okafor"]);
  });

  it("filters by specialty", async () => {
    expect(idsOf(await run({ specialty: "pediatrics" }))).toEqual(["prov_chen", "prov_nakamura"]);
  });

  it("applies specialty and name together", async () => {
    expect(idsOf(await run({ specialty: "dermatology", name_query: "Okafor" }))).toEqual(["prov_okafor"]);
    expect(idsOf(await run({ specialty: "cardiology", name_query: "Lee" }))).toEqual([]);
  });

  it("reports accepting_new_patients so the model can steer new patients away from Dr. Brooks", async () => {
    expect(outputOf(await run({ name_query: "Brooks" })).providers).toEqual([
      {
        provider_id: "prov_brooks",
        display_name: "Dr. Marcus Brooks",
        specialty: "family_medicine",
        accepting_new_patients: false,
      },
    ]);
  });

  it("answers no match with an empty list, not an error", async () => {
    expect(outputOf(await run({ name_query: "Smith" }))).toEqual({ providers: [] });
  });

  it(`caps the list at ${LIMITS.providersMaxResults}`, async () => {
    const extras: Provider[] = Array.from({ length: 25 }, (_, i) => {
      const letter = String.fromCharCode(97 + i);
      return {
        providerId: `prov_extra${letter}`,
        displayName: `Dr. Test Extra${letter.toUpperCase()}`,
        firstName: "Test",
        lastName: `Extra${letter.toUpperCase()}`,
        credentials: "MD",
        specialty: "family_medicine",
        acceptingNewPatients: true,
      };
    });
    repos = createInMemoryRepositories({
      seed: { ...fixture, providers: [...fixture.providers, ...extras] },
      clock,
      ids: sequentialIds(),
    });
    const all = idsOf(await run());
    expect(all).toHaveLength(LIMITS.providersMaxResults);
    // The cut keeps the repo order: the first entries are unchanged.
    expect(all.slice(0, 3)).toEqual(["prov_haddad", "prov_lee", "prov_okafor"]);
  });

  it("rejects invalid input", async () => {
    expect(errorOf(await run({ name_query: "   " })).code).toBe("INVALID_INPUT");
    expect(errorOf(await run({ specialty: "orthopedics" })).code).toBe("INVALID_INPUT");
  });

  it("rejects a model-supplied patient_id and reads no patient data", async () => {
    expect(errorOf(await run({ patient_id: WALTER })).code).toBe("INVALID_INPUT");
    // The answer doesn't depend on who is asking.
    expect(outputOf(await run({}, WALTER))).toEqual(outputOf(await run({}, MARIA)));
  });

  it("writes nothing", async () => {
    const before = repos.snapshot();
    await run({ name_query: "Lee" });
    expect(repos.snapshot()).toEqual(before);
  });
});
