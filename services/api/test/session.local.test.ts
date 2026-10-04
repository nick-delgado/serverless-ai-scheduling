/**
 * `POST /api/session` over the real DynamoDB repositories, against DynamoDB Local: the greeting's reads
 * (profile, appointments, provider) and restore's (newest conversation, its messages) as the deployed
 * function makes them. Skipped locally without DynamoDB Local; required in CI (see `dynamo-local.ts`).
 */
import { SessionResponse, type ConversationMessage, type PatientId } from "@sched/contracts";
import { FrozenClock, type Repositories } from "@sched/tools";
import { createDynamoRepositories, writeSeed } from "@sched/tools/dynamo";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleSession, type SessionDeps } from "../src/lib/session";
import { dynamoLocalAvailable, localClient, tableFactory } from "./dynamo-local";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const AISHA = FIXTURE_PATIENT_IDS["pat-aisha"];
const NO_PROFILE = "7e2a9c40-1b3d-4f5e-8a6c-0d9e8f7a6b5c";
const OLD = "00000000-0000-4000-8000-00000000a001";
const NEW = "00000000-0000-4000-8000-00000000a002";
const WALTERS = "00000000-0000-4000-8000-00000000a003";

const available = await dynamoLocalAvailable();
const client = localClient();
const tables = tableFactory(client);

afterAll(async () => {
  if (available) await tables.dropAll();
  client.destroy();
});

async function chat(
  repos: Repositories,
  patientId: PatientId,
  conversationId: string,
  createdAt: string,
  patientText: string,
  reply: string,
): Promise<void> {
  const base = { conversationId, turnId: "00000000-0000-4000-8000-0000000000d1", createdAt };
  const messages: ConversationMessage[] = [
    { ...base, seq: 0, role: "user", content: [{ type: "text", text: patientText }] },
    {
      ...base,
      seq: 1,
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t1", name: "get_my_appointments", input: { include_past: false } },
      ],
    },
    { ...base, seq: 2, role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "{}" }] },
    { ...base, seq: 3, role: "assistant", content: [{ type: "text", text: reply }] },
  ];
  await repos.conversations.append(patientId, messages);
}

describe.skipIf(!available)("POST /api/session over DynamoDB (DynamoDB Local)", () => {
  let deps: SessionDeps;

  beforeAll(async () => {
    const tableName = await tables.create();
    await writeSeed({ tableName, client, seed: buildClinicFixture() });
    const clock = new FrozenClock("2026-10-05T12:00:00Z");
    const repos = createDynamoRepositories({ tableName, client, clock });
    await chat(repos, MARIA, OLD, "2026-10-04T13:00:00.000Z", "Old question", "Old answer");
    await chat(repos, MARIA, NEW, "2026-10-05T11:00:00.000Z", "When am I booked?", "Tuesday at 2:30 PM.");
    await chat(repos, WALTER, WALTERS, "2026-10-05T11:30:00.000Z", "Walter asks", "Walter's answer");
    deps = { repos, clock };
  });

  async function session(patientId: PatientId): Promise<SessionResponse> {
    const res = await handleSession({ body: "{}", patientId, requestId: "req-local" }, deps);
    expect(res.statusCode).toBe(200);
    return SessionResponse.parse(JSON.parse(res.body));
  }

  it("greets with the profile and the next appointment, and restores the newest conversation", async () => {
    expect(await session(MARIA)).toEqual({
      patient: { firstName: "Maria" },
      greeting:
        "Hi Maria! I see you're booked with Dr. Priya Lee on Tuesday, October 13, 2026 at 2:30 PM ET. How can I help today?",
      upcomingAppointment: {
        appointmentId: "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY",
        providerName: "Dr. Priya Lee",
        specialty: "dermatology",
        startUtc: "2026-10-13T18:30:00Z",
        startLocal: "Tuesday, October 13, 2026 at 2:30 PM ET",
      },
      conversationId: NEW,
      messages: [
        {
          id: "msg_000000",
          role: "patient",
          text: "When am I booked?",
          createdAt: "2026-10-05T11:00:00.000Z",
        },
        {
          id: "msg_000003",
          role: "assistant",
          text: "Let me check.\n\nTuesday at 2:30 PM.",
          createdAt: "2026-10-05T11:00:00.000Z",
        },
      ],
    });
  });

  it("never restores another patient's newer conversation", async () => {
    const walter = await session(WALTER);
    expect(walter.conversationId).toBe(WALTERS);
    const aisha = await session(AISHA);
    expect(aisha).toMatchObject({ conversationId: null, messages: [], upcomingAppointment: null });
    expect(aisha.greeting).toBe("Hi Aisha! How can I help today?");
  });

  it("greets a patient with no profile and no data without a name", async () => {
    expect(await session(NO_PROFILE)).toEqual({
      patient: { firstName: "Patient" },
      greeting: "Hi there! How can I help today?",
      upcomingAppointment: null,
      conversationId: null,
      messages: [],
    });
  });
});
