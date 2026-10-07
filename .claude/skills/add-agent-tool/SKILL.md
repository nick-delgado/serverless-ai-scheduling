---
name: add-agent-tool
description: >-
  The recipe for adding, changing, or debugging one of the scheduling agent's tools
  (find_providers, check_availability, get_my_appointments, get_patient_profile,
  book_appointment, reschedule_appointment, escalate_to_human, or a new one). It covers:
  the @sched/contracts schema, the handler in packages/tools/src/tools/ (injected
  ToolContext, patient identity from the JWT, toolOk/toolFail with hints, clinic-local
  times), unit tests against in-memory repos and the clinic-default fixture, the
  TOOL_REGISTRY entry, writing the model-facing description, eval scenarios, and a
  definition-of-done checklist, with a worked get_patient_profile example. Use it
  whenever you touch packages/tools/src/tools/ or TOOL_REGISTRY, work on issues #19–#23
  (S4-01..S4-05), change a tool description or schema in packages/contracts/src/tools.ts,
  or a tool returns INVALID_INPUT/INTERNAL unexpectedly, isn't offered to the model, shows
  wrong times, or leaks data. Use it even if the user just says "implement book_appointment"
  or "the agent can't see my tool".
---

# Add an agent tool

The agent is only as safe as its tools. The model decides *which* tool to call and with *what* arguments, and anything it passes is untrusted. This recipe keeps five tools written in parallel consistent, and keeps the security rules in code, where a clever prompt can't talk its way around them.

Read first: `CLAUDE.md` rules 1, 2, 3, and 5; ADR-001 (the loop), ADR-004 (data model and access patterns), ADR-009 (safety policy).

## How the pieces fit

```
packages/contracts/src/tools.ts    TOOLS[name] = { name, description, input, output }   ← the contract (shared)
packages/tools/src/tools/<name>.ts ToolHandler<name>: (input, ctx) → toolOk | toolFail  ← your code
packages/tools/src/registry.ts     TOOL_REGISTRY[name] = handler                         ← one line
                                   createToolExecutor(registry, ctx)                     ← validates, runs, never throws
```

`createToolExecutor` already does the generic work, so a handler doesn't repeat it:

- unknown or unregistered name → `NOT_FOUND`;
- input parsed with `TOOLS[name].input` (strict objects, defaults applied) → `INVALID_INPUT` with the field list;
- handler throws, or returns output that fails `TOOLS[name].output` → `INTERNAL` with a generic message (the real cause goes to `onInternalError`, never to the model);
- only registered tools are offered to the model, in the stable contracts order.

How the contract becomes a model-facing definition (Messages API, Converse, or anything else) is the agent package's concern, and #60 is changing it. Think in terms of `TOOLS` and `createToolExecutor`, never a provider's JSON shape, and keep everything here model-agnostic.

## 1. The contract

All seven tools already have an input schema, an output schema, and a description in `packages/contracts/src/tools.ts`. Start from it; don't redefine shapes locally. `ToolInput<"name">` and `ToolOutput<"name">` give you the types.

If the contract is wrong or missing something, change it there, but know what that costs:

- `packages/contracts` is the integration seam, so it's a **cross-stream change**. Keep it minimal, run the contracts tests (`tools.test.ts` enforces "no patient identifier in any input"), and call it out in the PR.
- Tool definitions sit at the top of every prompt, before the cache breakpoint (ADR-001). Changing any byte of any tool invalidates the prompt cache and can shift model behavior, so it needs an eval run.
- Never add a `patient_id` (or `patient`, `user_id`, `email`, ...) to an input. The only way to choose whose data a tool touches is `ctx.patientId`. If you think a tool needs one, the design is wrong.
- New tool name: add it to `TOOL_NAMES`, `TOOLS`, and an anchor comment in `TOOL_REGISTRY` in the same PR.

## 2. The handler

File: `packages/tools/src/tools/<tool_name>.ts` (snake_case, matching the tool name and the issue's owned paths). Export one `ToolHandler<"tool_name">` named in camelCase.

**Use only what `ToolContext` gives you:** `ctx.patientId`, `ctx.conversationId`, `ctx.clock`, `ctx.repos`. No imports of AWS SDKs, `process.env`, argument-less `new Date()` or `Date.now()` (anything that reads the real clock; parsing a stored timestamp with `new Date(iso)` is fine), or module-level state. This is what lets the eval harness run the real handler against in-memory repos at a frozen instant (rule 3). If a tool needs a new dependency (the `Notifier` for escalate_to_human), add it to the context through an injected interface with an in-memory fake, and call out the `ToolContext` change in the PR, since every tool and both callers share it.

**Identity.** Every patient-owned read or write uses `ctx.patientId`. Repos return `null` (or `*_NOT_FOUND`) for another patient's records, so a cross-patient attempt looks exactly like "doesn't exist". Keep it that way in your messages: say "No appointment with that ID for you", never "That appointment belongs to someone else". Confirming existence leaks information.

**Writes are atomic.** Booking and rescheduling go through `appointments.book` / `appointments.reschedule`, which are one transaction each (rule 2). Don't read a slot, decide, then write. The repo's conditional write is the check. Tool-level rules that need "now" (for example "can't book a slot in the past") belong in the handler, using `ctx.clock.now()`, and run *before* the write but *after* the patient's own retry check: a patient who already holds the slot gets it back even if it has started (ADR-004 "first checks"; the full order is in `book_appointment.ts`'s header).

**Map every repo outcome to a result.** Expected outcomes are typed results, not throws. Map them with `toolOk(output)` or `toolFail(code, message, hint)`:

- Use `TOOL_ERROR_CODE_FOR[reason]` (from `repos/types.ts`) for repo failure reasons, so all tools pick the same code.
- `message` says what happened, in plain words, with no internals (no table keys, stack traces, or raw IDs the patient never saw). Max 300 chars.
- `hint` says what the model should do next: "Call check_availability again and offer other times", "Ask the patient which appointment they mean; call get_my_appointments to list them". A good hint is the difference between a recovery and an apology loop.
- Let genuinely unexpected failures throw. The executor turns them into `INTERNAL` and logs the cause.
- Return success for idempotent retries (`already_booked`, `already_rescheduled`, `already_escalated`) instead of an error. The model retries more than you'd expect.

**Times.** Store and compare UTC; show clinic-local. Every time the model might say out loud goes in a `*_local` field formatted with `formatClinicDateTime(startUtc)` from `src/clock.ts` ("Tuesday, October 13, 2026 at 2:30 PM ET"). The weekday is included on purpose: models are bad at computing weekdays from dates, and a wrong weekday in a confirmation is a real booking error. Date inputs are clinic-local days; convert with `clinicDateRangeUtc` / `zonedTimeToUtc`, which handle DST (the fixture window crosses Nov 1, 2026). Never do offset math by hand.

**Treat data as untrusted (rule 5).** Free text from the patient (`reason`, `summary`) and anything read from the store is data. Store and return it as a field; never splice it into `message`/`hint`, where it would read as an instruction. Don't echo more than the output schema asks for. Output schemas are strict, so an extra field becomes `INTERNAL`.

**Keep outputs small and quotable.** Return what the model needs for the next step and to confirm with the patient: IDs it will pass back, display names, `start_local`. The limits (`LIMITS.availabilityMaxSlots`, and so on) are in contracts; respect them and set `truncated` when you cut.

## 3. Unit tests

File: `packages/tools/test/tools/<tool_name>.test.ts`. Run through `createToolExecutor({ tool_name: handler }, ctx)`, not the bare handler. That exercises the strict input schema and output validation the model actually faces, so a green test means the model gets exactly that output.

Setup: `buildClinicFixture()` (from `../../fixtures`), a `FrozenClock` at `fixture.suggestedNow` (Mon Oct 5, 2026, 9:00 AM ET), `createInMemoryRepositories({ seed, clock, ids: sequentialIds() })`. Use `FIXTURE_PATIENT_IDS["pat-maria"]` etc., never invented people. Useful fixture facts: Maria prefers `prov_lee`; Aisha and James have no preferred provider; Brooks isn't accepting new patients; several patients already hold appointments, so those slots are BOOKED.

Cover, at minimum:

| Case | What it proves |
|---|---|
| Happy path | Exact output for a fixture patient, including `*_local` strings |
| Not found | Unknown ID, or a patient with no data → `NOT_FOUND` with a `hint` |
| Invalid input | A schema violation → `INVALID_INPUT` (one case is enough; the contract tests own the rest) |
| Cross-patient | An extra `patient_id` is rejected; another patient's IDs read as `NOT_FOUND`; and **nothing changed** (`repos.snapshot()` before/after) |
| Missing reference | A record pointing at a missing provider (stub the read to return `null`) → `INTERNAL` with nothing written, or the degraded output the handler documents |
| Tool-specific edges | Below |

Tool-specific edges worth a test each:

- **find_providers / check_availability:** empty result is success with `[]`, not an error; `time_of_day` boundary at 12:00 PM ET; the DST boundary (a slot on Nov 2 shows EST); truncation at the limit; specialty+day uses the sparse-index path (`listOpenBySpecialtyAndDay`).
- **get_my_appointments:** upcoming vs past split by `ctx.clock.now()` (advance the clock to prove it); `include_past` default.
- **book_appointment:** already-booked slot → `SLOT_UNAVAILABLE` with an alternatives hint; same patient retries → `already_booked: true` and one appointment in the snapshot; slot in the past; two concurrent calls (`Promise.all`) → exactly one booking.
- **reschedule_appointment:** another patient's appointment → `NOT_FOUND` and both slots unchanged; CANCELLED appointment → `NOT_ALLOWED`; a retry into the slot it already holds → `already_rescheduled: true` and nothing changed, even after the new time has started; new slot taken → nothing changed (all-or-nothing).
- **escalate_to_human:** second call → `already_escalated: true` and the notifier called once; notifier failure still records the escalation and still returns the phone/hours.

## 4. Register it

In `packages/tools/src/registry.ts`, each tool issue owns its two anchor comments, so parallel PRs don't conflict. Add the import under the import anchor and one line under the `TOOL_REGISTRY` anchor. Don't reorder or reformat anything else. Registration is also what makes the tool visible to the model: an unregistered tool is never offered.

## 5. The model-facing description

The description lives in `TOOLS[name].description` (contracts). The tool issues' acceptance criteria say "reviewed against these guidelines". Review it against each guideline below and say in the PR which it meets. If it fails one, fix it in the same PR, as a minimal, called-out contracts change (update the contracts snapshot).

- **What it's for and when to use it**, in the first sentence. "Use it to resolve a provider the patient mentions into a provider_id."
- **What it returns** and which fields to quote verbatim (`start_local`).
- **Rules the model must follow:** confirm-before-write for `book_appointment` / `reschedule_appointment` ("only after the patient has explicitly confirmed provider, date, time, and reason"); where IDs must come from ("slot_id must come from check_availability in this conversation"); "never ask for or pass a patient ID"; what an error means and what to do.
- **Concise.** A few sentences. Parameter-level detail goes in the schema's `.describe()`, not the description.
- **Stable wording.** Definitions are prompt-cached and evals are baselined against them. Don't tweak prose casually, don't interpolate anything that changes per request (dates, names), and reword a description that already meets every guideline only with an eval run.
- **Model-agnostic.** Plain instructions that any model (Claude, Nova, gpt-oss via Converse) can follow. No provider-specific tags or features.

The description is advice to the model. The handler must still enforce every rule it states that can be enforced in code. "Only book slot_ids check_availability returned" is advice; "the slot exists, is OPEN, and is in the future" is code.

## 6. Eval scenarios

Unit tests prove the handler is right; evals prove the model uses it right (ADR-008). For each tool, add or reference at least one **L1** case (given this conversation state, the next call is this tool with these args), plus the L2/L3 scenarios that exercise it:

- `packages/evals/scenarios/<category>/<id>.yaml` (categories: book, reschedule, availability, escalate, clarify, safety), `fixture: clinic-default`, `patient: pat-*`, clock `2026-10-05T13:00:00Z`.
- Scenarios live in `packages/evals/scenarios/` (see its README coverage table). If your case is already covered, reference its id in the PR; if not, add it. If you can't add it in this PR, list it on #201, the open eval follow-up issue (it replaced #80).
- Good trajectory checks for tools: `must_call_before: [check_availability, book_appointment]`, `must_confirm_before: <write tool>`, and no invented IDs. A safety case for every read tool: the patient asks for someone else's data.

## 7. Definition of done

- [ ] Handler in `packages/tools/src/tools/<name>.ts`, using only `ToolContext`; no `patient_id` in input; no clock reads outside `ctx.clock`, no AWS imports
- [ ] Every repo outcome mapped to `toolOk` / `toolFail` with a useful `hint`; no internals or cross-patient existence leaked
- [ ] Clinic-local times via `formatClinicDateTime`, with the weekday; DST-safe
- [ ] Tests via `createToolExecutor`: happy, not-found, invalid input, cross-patient (with snapshot unchanged), tool-specific edges
- [ ] Import and entry under the tool's anchors in `TOOL_REGISTRY`, nothing else touched
- [ ] Description reviewed against section 5; any contracts change minimal and called out
- [ ] L1 case added, referenced, or listed on #201
- [ ] `npm run lint && npm run typecheck && npm test` passes at the repo root
- [ ] Eval smoke suite run with no regression, numbers in the PR. If `npm run evals` doesn't exist yet (#30), say so in the PR
- [ ] Journal entry (via `dev-journal`) if you decided something the spec left open, or something surprised you

## Debugging a tool

| Symptom | Usual cause |
|---|---|
| Model never calls the tool | Not registered in `TOOL_REGISTRY` (the executor offers only registered tools), or the description doesn't say when to use it |
| `INVALID_INPUT` on a sensible call | Strict schema: the model sent an extra field (often `patient_id`, which is correct to reject) or a wrong format (`YYYY-MM-DD`, id prefixes). Read the error's field list |
| `INTERNAL` with "The tool failed unexpectedly" | The handler threw or its output failed `TOOLS[name].output` (extra field, over a max, wrong enum). The real cause went to `onInternalError`; reproduce in a unit test |
| Times off by an hour | Hand-rolled offset math, or a range built in UTC instead of `clinicDateRangeUtc`. Test a slot on each side of Nov 1 |
| Flaky or date-dependent tests | Something read the real clock. Use `ctx.clock` and a `FrozenClock` |
| Agent loops on apologies | The error has no `hint`, or the hint doesn't name a next action |

## Worked example: `get_patient_profile`

This is the pattern, not the shipped code (#20 owns the real file). It's the simplest tool: no input, one patient read, one optional provider read.

`packages/tools/src/tools/get_patient_profile.ts`:

```ts
/**
 * get_patient_profile (FR-037): the logged-in patient's name and preferred provider.
 * Identity comes from ctx.patientId (the verified JWT), never from input (CLAUDE.md rule 1).
 */
import type { Provider, ProviderSummary } from "@sched/contracts";

import { toolFail, toolOk, type ToolHandler } from "../registry";

const toProviderSummary = (p: Provider): ProviderSummary => ({
  provider_id: p.providerId,
  display_name: p.displayName,
  specialty: p.specialty,
  accepting_new_patients: p.acceptingNewPatients,
});

export const getPatientProfile: ToolHandler<"get_patient_profile"> = async (_input, ctx) => {
  const patient = await ctx.repos.patients.get(ctx.patientId);
  if (!patient) {
    return toolFail(
      "NOT_FOUND",
      "No profile is on file for the logged-in patient.",
      "Continue without the patient's name. If they need their profile, offer to connect them with the front desk.",
    );
  }

  // A preferred provider that no longer exists is not an error: the profile is still useful without it.
  const preferred = patient.preferredProviderId
    ? await ctx.repos.providers.get(patient.preferredProviderId)
    : null;

  return toolOk({
    first_name: patient.firstName,
    last_name: patient.lastName,
    preferred_provider: preferred ? toProviderSummary(preferred) : null,
  });
};
```

Things to notice: the input is ignored (the schema is `{}`, and strictness rejects anything else before the handler runs); `ctx.patientId` is the only identity; the not-found error has a next step; a dangling reference degrades to `null` instead of failing the whole call.

`packages/tools/test/tools/get_patient_profile.test.ts`:

```ts
import { TOOLS, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import { createToolExecutor, type ToolContext, type ToolExecutionResult } from "../../src/registry";
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

  // Go through the executor, not the bare handler: it applies the contracts schemas the model faces
  // (strict input, output shape), so a passing test means the model gets exactly this.
  const run = (patientId: string, input: unknown = {}): Promise<ToolExecutionResult> => {
    const ctx: ToolContext = { patientId, conversationId: EXAMPLES.ConversationId, clock, repos };
    return createToolExecutor({ get_patient_profile: getPatientProfile }, ctx).execute({
      id: "toolu_test",
      name: "get_patient_profile",
      input,
    });
  };

  beforeEach(() => {
    const fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow);
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("returns the logged-in patient's name and preferred provider", async () => {
    expect(outputOf(await run(MARIA))).toEqual({
      first_name: "Maria",
      last_name: "Santos",
      preferred_provider: {
        provider_id: "prov_lee",
        display_name: "Dr. Priya Lee",
        specialty: "dermatology",
        accepting_new_patients: true,
      },
    });
  });

  it("returns preferred_provider: null when the patient has none", async () => {
    expect(outputOf(await run(AISHA))).toMatchObject({ first_name: "Aisha", preferred_provider: null });
  });

  it("answers NOT_FOUND with a hint when the patient has no profile", async () => {
    const error = errorOf(await run(UNKNOWN));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toBeDefined();
  });

  it("rejects any input field, including a model-supplied patient_id", async () => {
    expect(errorOf(await run(MARIA, { patient_id: WALTER })).code).toBe("INVALID_INPUT");
  });

  it("only ever reads the context patient (cross-patient attempt)", async () => {
    // Asking for Maria while logged in as Walter is rejected, never answered with her data...
    expect(errorOf(await run(WALTER, { patient_id: MARIA })).code).toBe("INVALID_INPUT");
    // ...and Walter's context only ever yields Walter.
    expect(outputOf(await run(WALTER))).toMatchObject({ first_name: "Walter", last_name: "Haines" });
  });

  it("writes nothing", async () => {
    const before = repos.snapshot();
    await run(MARIA);
    expect(repos.snapshot()).toEqual(before);
  });
});
```

Registration in `packages/tools/src/registry.ts` (two lines, each under its `#20` anchor):

```ts
// #20 get_my_appointments, get_patient_profile
import { getPatientProfile } from "./tools/get_patient_profile";
```

```ts
export const TOOL_REGISTRY: ToolRegistry = {
  // #19 find_providers, check_availability
  // #20 get_my_appointments, get_patient_profile
  get_patient_profile: getPatientProfile,
  // #21 book_appointment
  ...
};
```

Eval coverage for it: an L1 case "patient says 'who's my usual doctor?' → calls get_patient_profile with `{}`", and a safety case "patient asks for another patient's profile → no tool call with another identity, polite decline".

This example was verified against the repo at the time of writing: the handler, the test (6 passing), and the registration typecheck, lint, and pass `npm test -w packages/tools`. If it drifts from the code, the code wins; update the example.
