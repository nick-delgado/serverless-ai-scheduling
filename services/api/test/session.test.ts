/**
 * `POST /api/session` core (`lib/session.ts`, `lib/greeting.ts`) against the in-memory repositories and
 * the `clinic-default` fixture, with a frozen clock. Maria's appointment: Dr. Priya Lee, Tuesday
 * October 13, 2026 at 2:30 PM ET (18:30 UTC).
 */
import {
  ApiError,
  SessionResponse,
  type ConversationMessage,
  type PatientId,
  type UpcomingAppointment,
} from "@sched/contracts";
import { FrozenClock, createInMemoryRepositories, type Repositories } from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import type { LogEntry } from "../src";
import { nextUpcomingAppointment, sessionGreeting } from "../src/lib/greeting";
import { handleSession, isEmptySessionBody, sessionProxyHandler, type SessionDeps } from "../src/lib/session";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const AISHA = FIXTURE_PATIENT_IDS["pat-aisha"];
const DANIEL = FIXTURE_PATIENT_IDS["pat-daniel"];
const NO_PROFILE = "7e2a9c40-1b3d-4f5e-8a6c-0d9e8f7a6b5c";
const MARIA_START = "2026-10-13T18:30:00Z";

function setup(now = "2026-10-05T12:00:00Z") {
  const clock = new FrozenClock(now);
  const repos = createInMemoryRepositories({ clock, seed: buildClinicFixture() });
  const logs: LogEntry[] = [];
  const deps: SessionDeps = { repos, clock, log: (e) => logs.push(e) };
  return { clock, repos, logs, deps };
}

async function session(
  deps: SessionDeps,
  patientId: PatientId | undefined = MARIA,
  body: string | null = null,
) {
  const res = await handleSession({ body, patientId, requestId: "req-1" }, deps);
  return { res, json: JSON.parse(res.body) as unknown };
}

async function ok(deps: SessionDeps, patientId: PatientId = MARIA): Promise<SessionResponse> {
  const { res, json } = await session(deps, patientId);
  expect(res.statusCode).toBe(200);
  return SessionResponse.parse(json);
}

/** Appends one user + one assistant message, starting a conversation (`seq` 0) or continuing it. */
async function chat(
  repos: Repositories,
  patientId: PatientId,
  conversationId: string,
  firstSeq: number,
  createdAt: string,
  patientText: string,
  reply: string,
): Promise<void> {
  const base = { conversationId, turnId: "00000000-0000-4000-8000-0000000000d1", createdAt };
  const messages: ConversationMessage[] = [
    { ...base, seq: firstSeq, role: "user", content: [{ type: "text", text: patientText }] },
    { ...base, seq: firstSeq + 1, role: "assistant", content: [{ type: "text", text: reply }] },
  ];
  await repos.conversations.append(patientId, messages);
}

describe("greeting", () => {
  it("greets by first name and names the next appointment in clinic-local time with the weekday", async () => {
    const { deps } = setup();
    const body = await ok(deps);
    const upcoming: UpcomingAppointment = {
      appointmentId: "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY",
      providerName: "Dr. Priya Lee",
      specialty: "dermatology",
      startUtc: MARIA_START,
      startLocal: "Tuesday, October 13, 2026 at 2:30 PM ET",
    };
    expect(body).toEqual({
      patient: { firstName: "Maria" },
      greeting:
        "Hi Maria! I see you're booked with Dr. Priya Lee on Tuesday, October 13, 2026 at 2:30 PM ET. How can I help today?",
      upcomingAppointment: upcoming,
      conversationId: null,
      messages: [],
    });
  });

  it("greets a patient with no appointments without mentioning one", async () => {
    const { deps } = setup();
    const body = await ok(deps, AISHA);
    expect(body.patient.firstName).toBe("Aisha");
    expect(body.greeting).toBe("Hi Aisha! How can I help today?");
    expect(body.upcomingAppointment).toBeNull();
  });

  it("greets a patient with no profile on file without a name", async () => {
    const { deps, logs } = setup();
    const body = await ok(deps, NO_PROFILE);
    expect(body.patient.firstName).toBe("Patient");
    expect(body.greeting).toBe("Hi there! How can I help today?");
    expect(logs.at(-1)).toMatchObject({ msg: "session", hasProfile: false, hasUpcoming: false });
  });

  it("templates the no-name greeting with an appointment too", () => {
    const upcoming = { providerName: "Dr. Priya Lee", startLocal: "Tuesday" } as UpcomingAppointment;
    expect(sessionGreeting(null, upcoming)).toBe(
      "Hi there! I see you're booked with Dr. Priya Lee on Tuesday. How can I help today?",
    );
  });

  it("counts an appointment starting exactly now as upcoming, and not one that started a millisecond ago", async () => {
    const { deps, clock } = setup(MARIA_START);
    expect((await ok(deps)).upcomingAppointment?.startUtc).toBe(MARIA_START);
    clock.advance(1);
    const later = await ok(deps);
    expect(later.upcomingAppointment).toBeNull();
    expect(later.greeting).toBe("Hi Maria! How can I help today?");
  });

  it("names the next BOOKED appointment: not a past one, not a cancelled one", async () => {
    // Daniel: BOOKED Wed Oct 7 4:00 PM ET with Dr. Kowalski, CANCELLED Fri Oct 9 9:00 AM ET with Dr. Okafor.
    const before = setup("2026-10-07T12:00:00Z");
    expect((await ok(before.deps, DANIEL)).upcomingAppointment).toMatchObject({
      providerName: "Dr. Anna Kowalski",
      startLocal: "Wednesday, October 7, 2026 at 4:00 PM ET",
    });
    const after = setup("2026-10-07T21:00:00Z");
    expect((await ok(after.deps, DANIEL)).upcomingAppointment).toBeNull();
  });

  it("picks the earliest of several upcoming BOOKED appointments", () => {
    const { appointments } = buildClinicFixture();
    const booked = appointments.filter((a) => a.status === "BOOKED");
    // listForPatient's order: ascending by start.
    const sorted = [...booked].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    expect(sorted.length).toBeGreaterThan(2);
    const now = new Date(Date.parse(sorted[0]?.startUtc ?? "") + 1);
    expect(nextUpcomingAppointment(sorted, now)).toEqual(sorted[1]);
  });

  it("skips a past COMPLETED appointment and finds the BOOKED one after it", async () => {
    const { deps } = setup();
    expect((await ok(deps, WALTER)).upcomingAppointment?.appointmentId).toBe(
      "appt_01JBX8C4D5E6F7G8H9J0K1M2N3",
    );
  });

  it("fails with INTERNAL rather than invent a provider name", async () => {
    const { deps, logs } = setup();
    const repos = { ...deps.repos, providers: { ...deps.repos.providers, get: () => Promise.resolve(null) } };
    const { res, json } = await session({ ...deps, repos });
    expect(res.statusCode).toBe(500);
    expect(ApiError.parse(json).error.code).toBe("INTERNAL");
    expect(logs.map((l) => l.msg)).toEqual(["session failed", "session"]);
    expect(logs[0]).toMatchObject({ errorMessage: "Appointment references unknown provider prov_lee" });
    expect(logs.at(-1)).toMatchObject({ status: 500, requestId: "req-1" });
  });
});

describe("restore", () => {
  it("returns the patient's newest conversation as display messages", async () => {
    const { deps, repos } = setup();
    const OLD = "00000000-0000-4000-8000-00000000a001";
    const NEW = "00000000-0000-4000-8000-00000000a002";
    await chat(repos, MARIA, OLD, 0, "2026-10-04T13:00:00.000Z", "Old question", "Old answer");
    await chat(repos, MARIA, NEW, 0, "2026-10-05T11:00:00.000Z", "Any openings?", "Yes, Monday.");
    await chat(repos, MARIA, NEW, 2, "2026-10-05T11:01:00.000Z", "Book it", "Done.");

    const body = await ok(deps);
    expect(body.conversationId).toBe(NEW);
    expect(body.messages).toEqual([
      { id: "msg_000000", role: "patient", text: "Any openings?", createdAt: "2026-10-05T11:00:00.000Z" },
      { id: "msg_000001", role: "assistant", text: "Yes, Monday.", createdAt: "2026-10-05T11:00:00.000Z" },
      { id: "msg_000002", role: "patient", text: "Book it", createdAt: "2026-10-05T11:01:00.000Z" },
      { id: "msg_000003", role: "assistant", text: "Done.", createdAt: "2026-10-05T11:01:00.000Z" },
    ]);
  });

  it("never returns another patient's conversation, even a newer one", async () => {
    const { deps, repos } = setup();
    const MINE = "00000000-0000-4000-8000-00000000b001";
    const THEIRS = "00000000-0000-4000-8000-00000000b002";
    await chat(repos, MARIA, MINE, 0, "2026-10-05T10:00:00.000Z", "Mine", "Reply to Maria");
    await chat(repos, WALTER, THEIRS, 0, "2026-10-05T11:00:00.000Z", "Walter's question", "Reply to Walter");

    const maria = await ok(deps, MARIA);
    expect(maria.conversationId).toBe(MINE);
    expect(JSON.stringify(maria)).not.toContain("Walter");
    const aisha = await ok(deps, AISHA);
    expect(aisha.conversationId).toBeNull();
    expect(aisha.messages).toEqual([]);
  });

  it("reads messages only through the caller's own patient-scoped reads", async () => {
    const { deps, repos } = setup();
    const CONV = "00000000-0000-4000-8000-00000000c001";
    await chat(repos, MARIA, CONV, 0, "2026-10-05T10:00:00.000Z", "Hi", "Hello");
    const calls: unknown[][] = [];
    const conversations = {
      ...repos.conversations,
      listConversations: (...args: Parameters<Repositories["conversations"]["listConversations"]>) => {
        calls.push(["listConversations", ...args]);
        return repos.conversations.listConversations(...args);
      },
      listMessages: (...args: Parameters<Repositories["conversations"]["listMessages"]>) => {
        calls.push(["listMessages", ...args]);
        return repos.conversations.listMessages(...args);
      },
    };
    await ok({ ...deps, repos: { ...repos, conversations } });
    expect(calls).toEqual([
      ["listConversations", MARIA, { limit: 1 }],
      ["listMessages", MARIA, CONV],
    ]);
    // No conversation: nothing to read beyond the (empty) list.
    calls.length = 0;
    await ok({ ...deps, repos: { ...repos, conversations } }, AISHA);
    expect(calls).toEqual([["listConversations", AISHA, { limit: 1 }]]);
  });

  it("restores nothing when the newest conversation's messages have expired", async () => {
    const { deps, repos } = setup();
    await chat(
      repos,
      MARIA,
      "00000000-0000-4000-8000-00000000d001",
      0,
      "2026-10-05T10:00:00.000Z",
      "Hi",
      "Hello",
    );
    const conversations = { ...repos.conversations, listMessages: () => Promise.resolve([]) };
    const body = await ok({ ...deps, repos: { ...repos, conversations } });
    expect(body.conversationId).toBeNull();
    expect(body.messages).toEqual([]);
  });

  it("returns the conversation ID while stored messages remain, even with nothing displayable", async () => {
    const { deps, repos } = setup();
    const CONV = "00000000-0000-4000-8000-00000000e001";
    await chat(repos, MARIA, CONV, 0, "2026-10-05T10:00:00.000Z", "Hi", "Hello");
    const conversations = {
      ...repos.conversations,
      listMessages: async (p: PatientId, c: string) =>
        (await repos.conversations.listMessages(p, c)).map((m) => ({
          ...m,
          content: [{ type: "tool_use" as const, id: "t1", name: "get_my_appointments", input: {} }],
        })),
    };
    const body = await ok({ ...deps, repos: { ...repos, conversations } });
    expect(body.conversationId).toBe(CONV);
    expect(body.messages).toEqual([]);
  });

  it("starts the profile, appointment and conversation reads together, then the provider and messages", async () => {
    const { deps, repos } = setup();
    await chat(
      repos,
      MARIA,
      "00000000-0000-4000-8000-00000000f001",
      0,
      "2026-10-05T10:00:00.000Z",
      "Hi",
      "Hello",
    );
    const started: string[] = [];
    // Each read waits for its round's gate, so a read that only starts after another finishes shows up.
    const round = (): { open: () => void; gate: Promise<void> } => {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      return { open, gate };
    };
    const first = round();
    const second = round();
    const gated =
      <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>, gate: Promise<void>) =>
      async (...a: A): Promise<R> => {
        started.push(name);
        await gate;
        return fn(...a);
      };
    const wrapped = {
      ...repos,
      patients: { get: gated("profile", repos.patients.get, first.gate) },
      appointments: {
        ...repos.appointments,
        listForPatient: gated("appointments", repos.appointments.listForPatient, first.gate),
      },
      providers: { ...repos.providers, get: gated("provider", repos.providers.get, second.gate) },
      conversations: {
        ...repos.conversations,
        listConversations: gated("conversations", repos.conversations.listConversations, first.gate),
        listMessages: gated("messages", repos.conversations.listMessages, second.gate),
      },
    };
    const pending = handleSession(
      { body: null, patientId: MARIA, requestId: "r" },
      { ...deps, repos: wrapped },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["profile", "appointments", "conversations"]);
    first.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(started.slice(3).sort()).toEqual(["messages", "provider"]);
    second.open();
    expect((await pending).statusCode).toBe(200);
  });
  it("answers 500, not a contract-breaking body, when a stored message can't be displayed", async () => {
    const { deps, repos, logs } = setup();
    const CONV = "00000000-0000-4000-8000-00000000e002";
    await chat(repos, MARIA, CONV, 0, "2026-10-05T10:00:00.000Z", "Hi", "Hello");
    const conversations = {
      ...repos.conversations,
      listMessages: async (p: PatientId, c: string) =>
        (await repos.conversations.listMessages(p, c)).map((m) => ({ ...m, createdAt: "yesterday" })),
    };
    const { res, json } = await session({ ...deps, repos: { ...repos, conversations } });
    expect(res.statusCode).toBe(500);
    expect(ApiError.parse(json).error.code).toBe("INTERNAL");
    expect(logs[0]).toMatchObject({ msg: "session failed", errorName: "ZodError" });
  });
});

describe("request", () => {
  it.each([null, "", "  ", "{}", " { } "])("accepts the empty body %j", (body) => {
    expect(isEmptySessionBody(body)).toBe(true);
  });

  it.each(['{"patientId":"3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01"}', "[]", "null", '"x"', "1", "not json"])(
    "rejects the body %j with 400",
    async (body) => {
      expect(isEmptySessionBody(body)).toBe(false);
      const { deps } = setup();
      const { res, json } = await session(deps, MARIA, body);
      expect(res.statusCode).toBe(400);
      expect(ApiError.parse(json).error.code).toBe("BAD_REQUEST");
    },
  );

  it("refuses a request without a verified patient with 401, before reading anything or checking the body", async () => {
    const { deps } = setup();
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw new Error("no repository may be read");
        },
      },
    ) as Repositories;
    const res = await handleSession(
      { body: "not json", patientId: undefined, requestId: "req-1" },
      { ...deps, repos: throwing },
    );
    const json: unknown = JSON.parse(res.body);
    expect(res.statusCode).toBe(401);
    expect(ApiError.parse(json).error.code).toBe("UNAUTHORIZED");
  });

  it("takes the patient from the authorizer's sub and decodes a base64 body", async () => {
    const { deps } = setup();
    const handler = sessionProxyHandler(deps);
    const event = (sub: string | undefined, body: string | null, isBase64Encoded = false) => ({
      body,
      isBase64Encoded,
      requestContext: { requestId: "req-2", authorizer: { claims: { sub } } },
    });
    const res = await handler(event(AISHA, Buffer.from("{}").toString("base64"), true));
    expect(res.statusCode).toBe(200);
    expect(SessionResponse.parse(JSON.parse(res.body)).patient.firstName).toBe("Aisha");
    expect((await handler(event("not-a-uuid", null))).statusCode).toBe(401);
    expect((await handler({ body: null, requestContext: { requestId: "r" } })).statusCode).toBe(401);
  });

  it("sends JSON that is never cached", async () => {
    const { deps } = setup();
    const { res } = await session(deps);
    expect(res.headers).toMatchObject({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });
});

describe("logging", () => {
  it("logs one line with IDs, flags, counts and timings, never names or message text", async () => {
    const { deps, repos, logs } = setup();
    const CONV = "00000000-0000-4000-8000-00000000aa01";
    await chat(repos, MARIA, CONV, 0, "2026-10-05T10:00:00.000Z", "My knee hurts", "Sorry to hear that");
    let t = 100;
    await ok({ ...deps, monotonicNow: () => (t += 7) });
    expect(logs.slice(0, 1)).toEqual([
      {
        msg: "session",
        requestId: "req-1",
        status: 200,
        hasProfile: true,
        hasUpcoming: true,
        conversationId: CONV,
        displayMessages: 2,
        totalMs: 7,
      },
    ]);
    // Without an injected monotonic clock, timings come from performance.now.
    await ok(deps);
    expect(logs).toHaveLength(2);
    expect(logs.at(-1)?.totalMs).toEqual(expect.any(Number));
    expect(Number.isFinite(logs.at(-1)?.totalMs)).toBe(true);
    const text = JSON.stringify(logs);
    for (const secret of ["Maria", "knee", "Sorry", "Lee"]) expect(text).not.toContain(secret);
  });
});
