/**
 * Integration tests for the chat turn core (#17): the real agent loop, the real tool registry and
 * executor, in-memory repositories seeded with the clinic-default fixture, a FrozenClock, and a
 * `ScriptedLlmClient` in place of Bedrock. Only the transport is absent.
 */
import {
  FALLBACK_MESSAGES,
  ScriptedLlmClient,
  resolveModelProfile,
  scriptedMalformed,
  scriptedMaxTokens,
  scriptedRefusal,
  scriptedText,
  scriptedToolUse,
  type ScriptedStep,
} from "@sched/agent";
import { isTerminalEvent, visibleText, type ConversationMessage, type PatientId } from "@sched/contracts";
import {
  ConversationAppendError,
  FrozenClock,
  RecordingNotifier,
  createInMemoryRepositories,
  formatClinicDateTime,
  type InMemoryRepositories,
} from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import {
  createInMemoryTurnStore,
  handleChatTurn,
  memorySink,
  placeholderSystemPrompt,
  type ChatTurnDeps,
  type LogEntry,
} from "../src";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const NOW = "2026-10-05T13:00:00Z"; // Monday 9:00 AM ET
const CLIENT_MESSAGE_ID = "5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c";
/** A valid patient ID with no profile in the fixture. */
const NO_PROFILE = "9d1e4b7a-2c3f-4a5b-8e6d-1f2a3b4c5d6e";
const throttled = Object.assign(new Error("Too many requests"), {
  name: "ThrottlingException",
  $metadata: { httpStatusCode: 429 },
});
/** A hand-seeded conversation for retry cases this handler can't produce itself (#104). */
const SEEDED_CONVERSATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SEEDED_CLIENT_MESSAGE_ID = "0b6f3f0e-8a51-4c3e-9d0a-2f6a3c1d9e47";
const seededRow = (
  seq: number,
  role: "user" | "assistant",
  content: ConversationMessage["content"],
): ConversationMessage => ({
  conversationId: SEEDED_CONVERSATION,
  seq,
  role,
  content,
  turnId: "00000000-0000-4000-8000-0000000000ff",
  createdAt: NOW,
});

function uuidSequence(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

interface World {
  deps: ChatTurnDeps;
  repos: InMemoryRepositories;
  turns: ReturnType<typeof createInMemoryTurnStore>;
  llm: ScriptedLlmClient;
  clock: FrozenClock;
  notifier: RecordingNotifier;
  logs: LogEntry[];
  /** Send one message as `patientId` and collect the response. */
  send: (
    text: string,
    options?: {
      patientId?: string | undefined;
      conversationId?: string;
      /** Repeat an earlier send's ID (a Retry). Every send gets a fresh one otherwise. */
      clientMessageId?: string;
      body?: string | null;
      signal?: AbortSignal;
    },
  ) => Promise<{
    response: ReturnType<typeof memorySink>["response"];
    summary: Awaited<ReturnType<typeof handleChatTurn>>;
    /** The `clientMessageId` this send used. */
    clientMessageId: string;
  }>;
}

function world(
  options: { steps?: ScriptedStep[]; cap?: number; overrides?: Partial<ChatTurnDeps> } = {},
): World {
  const clock = new FrozenClock(NOW);
  const repos = createInMemoryRepositories({ clock, seed: buildClinicFixture() });
  const turns = createInMemoryTurnStore();
  const llm = new ScriptedLlmClient(options.steps ?? []);
  const notifier = new RecordingNotifier();
  const logs: LogEntry[] = [];
  let sends = 0;
  const deps: ChatTurnDeps = {
    repos,
    turns,
    llm,
    profile: resolveModelProfile("sonnet-4.6"),
    clock,
    systemPrompt: placeholderSystemPrompt,
    dailyTurnCap: options.cap ?? 50,
    notifier,
    newId: uuidSequence(),
    log: (entry) => logs.push(entry),
    ...options.overrides,
  };
  return {
    deps,
    repos,
    turns,
    llm,
    clock,
    notifier,
    logs,
    async send(text, o = {}) {
      const { sink, response } = memorySink();
      // A fresh ID per send, so only a send that asks to repeat one is a Retry (A-9).
      const clientMessageId =
        o.clientMessageId ?? `c1e2a3b4-0000-4000-8000-${String(++sends).padStart(12, "0")}`;
      const body =
        o.body !== undefined
          ? o.body
          : JSON.stringify({
              clientMessageId,
              text,
              ...(o.conversationId === undefined ? {} : { conversationId: o.conversationId }),
            });
      const summary = await handleChatTurn(
        {
          body,
          patientId: "patientId" in o ? o.patientId : MARIA,
          requestId: "req-test",
          ...(o.signal ? { signal: o.signal } : {}),
        },
        deps,
        sink,
      );
      return { response, summary, clientMessageId };
    },
  };
}

const messagesOf = (repos: InMemoryRepositories, patientId: PatientId, conversationId: string) =>
  repos.conversations.listMessages(patientId, conversationId);

const textOf = (m: ConversationMessage): string =>
  m.content.map((b) => (b.type === "text" ? b.text : "")).join("");

/** Narrow away undefined, failing the test instead of using a non-null assertion. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const idOf = (summary: { conversationId?: string | undefined }): string => defined(summary.conversationId);

/** Every response must end with exactly one terminal event, last, and be ended once. */
function expectWellFormed(response: ReturnType<typeof memorySink>["response"]): void {
  expect(response.opens).toBe(1);
  expect(response.ended).toBe(true);
  expect(response.events.filter(isTerminalEvent)).toHaveLength(1);
  expect(isTerminalEvent(response.events.at(-1))).toBe(true);
}

/** Converse rejects two consecutive messages with the same role. */
function expectAlternating(messages: readonly { role: string }[]): void {
  for (let i = 1; i < messages.length; i++) expect(messages[i]?.role).not.toBe(messages[i - 1]?.role);
}

describe("handleChatTurn: happy paths", () => {
  it("starts a conversation, streams the reply, and stores both messages and the trace", async () => {
    const w = world({ steps: [scriptedText("Hi Maria! How can I help you today?")] });
    const { response, summary } = await w.send("Hello");

    expectWellFormed(response);
    expect(response.status).toBe(200);
    expect(visibleText(response.events)).toBe("Hi Maria! How can I help you today?");
    const done = response.events.at(-1);
    expect(done).toMatchObject({ type: "done", messageId: "msg_000001" });
    expect(done?.type === "done" && done.usage.inputTokens).toBe(100);

    const conversationId = idOf(summary);
    expect(done?.type === "done" && done.conversationId).toBe(conversationId);
    expect(summary.conversationReplaced).toBe(false);
    const stored = await messagesOf(w.repos, MARIA, conversationId);
    expect(stored.map((m) => [m.seq, m.role, textOf(m)])).toEqual([
      [0, "user", "Hello"],
      [1, "assistant", "Hi Maria! How can I help you today?"],
    ]);
    expect(stored.every((m) => m.turnId === summary.turnId)).toBe(true);

    expect(w.turns.traces).toHaveLength(1);
    expect(w.turns.traces[0]).toMatchObject({
      patientId: MARIA,
      trace: { conversationId, outcome: "completed" },
    });
    expect(w.turns.turnsUsed(MARIA, "2026-10-05")).toBe(1);
  });

  const systemOf = (w: World): string | undefined =>
    w.llm.requests[0]?.system.map((b) => ("text" in b ? b.text : "")).join("\n");

  it("passes the patient's first name and the injected clock's time, in clinic time, to the system prompt", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    await w.send("Hello");
    const system = systemOf(w);
    expect(system).toContain("first name is Maria");
    // The frozen instant rendered in Eastern Time (9:00 AM), not the wall clock and not UTC (1:00 PM).
    expect(system).toContain(`Current time: ${formatClinicDateTime(new Date(NOW))}`);
  });

  it("leaves the first name out of the prompt for a patient with no profile on file", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    const { response } = await w.send("Hello", { patientId: NO_PROFILE });
    expect(response.events.at(-1)?.type).toBe("done");
    expect(systemOf(w)).toContain("Current time:");
    expect(systemOf(w)).not.toContain("first name is");
  });

  it("runs tools, streams their status, and stores the tool messages verbatim", async () => {
    const w = world({
      steps: [
        scriptedToolUse([{ id: "tu_1", name: "find_providers", input: { name_query: "Lee" } }]),
        scriptedText("Dr. Lee is in family medicine."),
      ],
    });
    const { response, summary } = await w.send("Who is Dr. Lee?");

    expectWellFormed(response);
    expect(response.events[0]).toMatchObject({ type: "status", tool: "find_providers" });
    expect(response.events.at(-1)).toMatchObject({ type: "done", messageId: "msg_000003" });
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(stored[1]?.content[0]).toMatchObject({ type: "tool_use", id: "tu_1", name: "find_providers" });
    expect(stored[2]?.content[0]).toMatchObject({ type: "tool_result", toolUseId: "tu_1" });
  });

  it("continues an owned conversation: loads its history and appends after it", async () => {
    const w = world({ steps: [scriptedText("Hi!"), scriptedText("Sure, which day?")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    const { response, summary } = await w.send("I need an appointment", { conversationId });

    expect(summary.conversationId).toBe(conversationId);
    expect(summary.conversationReplaced).toBe(false);
    expect(response.events.at(-1)).toMatchObject({ type: "done", conversationId, messageId: "msg_000003" });
    // The second model call saw the first turn.
    const sent = w.llm.requests[1]?.messages.map((m) => m.role);
    expect(sent).toEqual(["user", "assistant", "user"]);
    expect((await messagesOf(w.repos, MARIA, conversationId)).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("forwards text_reset when a streamed response is discarded, so the client shows what was stored", async () => {
    const w = world({
      steps: [scriptedMaxTokens({ partialText: "Let me think about th" }), scriptedText("Here you go.")],
    });
    const { response, summary } = await w.send("Hello");

    expect(response.events.some((e) => e.type === "text_reset")).toBe(true);
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    expect(visibleText(response.events)).toBe(textOf(defined(stored.at(-1))));
    expect(response.events.at(-1)?.type).toBe("done");
  });

  it.each<[string, ScriptedStep[]]>([
    ["refusal", [scriptedRefusal(), scriptedRefusal()]],
    ["malformed_output", [scriptedMalformed(), scriptedMalformed()]],
    ["max_tokens", [scriptedMaxTokens(), scriptedMaxTokens()]],
    ["context_window_exceeded", [{ content: [], stopReason: "context_window_exceeded" }]],
  ])("ends a %s turn with done and the stored fallback reply", async (outcome, steps) => {
    const w = world({ steps: [...steps] });
    const { response, summary } = await w.send("Hello");

    expectWellFormed(response);
    expect(summary.outcome).toBe(outcome);
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    expect(response.events.at(-1)).toMatchObject({
      type: "done",
      messageId: `msg_00000${stored.length - 1}`,
    });
    expect(visibleText(response.events)).toBe(textOf(defined(stored.at(-1))));
  });
});

describe("handleChatTurn: identity and ownership", () => {
  it("binds tools to the JWT patient: the profile tool reads Maria's record", async () => {
    const w = world({
      steps: [
        scriptedToolUse([{ id: "tu_p", name: "get_patient_profile", input: {} }]),
        scriptedText("Done."),
      ],
    });
    const { summary } = await w.send("What's my date of birth?");
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    const result = stored[2]?.content[0];
    expect(result?.type === "tool_result" && result.content).toContain("Santos");
  });

  it("rejects a model-supplied patient id instead of using it", async () => {
    const w = world({
      steps: [
        scriptedToolUse([{ id: "tu_x", name: "get_patient_profile", input: { patient_id: WALTER } }]),
        scriptedText("Sorry."),
      ],
    });
    const { summary } = await w.send("Show me Walter's profile");
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    const result = stored[2]?.content[0];
    expect(result).toMatchObject({ type: "tool_result", isError: true });
    expect(result?.type === "tool_result" && result.content).toContain("INVALID_INPUT");
    expect(result?.type === "tool_result" && result.content).not.toContain("Walter");
  });

  it("never reads or extends another patient's conversation: it starts a new one instead", async () => {
    const w = world({ steps: [scriptedText("Hi Maria!"), scriptedText("Hi Walter!")] });
    const maria = await w.send("My secret is in here");
    const mariaConversation = idOf(maria.summary);

    const walter = await w.send("Continue please", { patientId: WALTER, conversationId: mariaConversation });

    expectWellFormed(walter.response);
    expect(walter.summary.conversationReplaced).toBe(true);
    expect(walter.summary.conversationId).not.toBe(mariaConversation);
    expect(walter.response.events.at(-1)).toMatchObject({ type: "done", messageId: "msg_000001" });
    // The model saw none of Maria's history...
    expect(w.llm.requests[1]?.messages).toHaveLength(1);
    expect(JSON.stringify(w.llm.requests[1])).not.toContain("secret");
    // ...and her conversation is untouched.
    expect(await messagesOf(w.repos, MARIA, mariaConversation)).toHaveLength(2);
    expect(await messagesOf(w.repos, WALTER, idOf(walter.summary))).toHaveLength(2);
  });

  it("treats an unknown conversation id the same way", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    const unknown = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const { summary } = await w.send("Hello", { conversationId: unknown });
    expect(summary.conversationReplaced).toBe(true);
    expect(summary.conversationId).not.toBe(unknown);
  });

  it("binds escalations to the loaded conversation, with the patient's message already in the transcript", async () => {
    const w = world({
      steps: [
        scriptedToolUse([
          {
            id: "tu_e",
            name: "escalate_to_human",
            input: { reason: "patient_requested", summary: "Patient asked to speak with the front desk." },
          },
        ]),
        scriptedText("I've let the front desk know."),
      ],
    });
    const { summary } = await w.send("Please get me a human");

    expect(w.notifier.sent).toHaveLength(1);
    expect(w.notifier.sent[0]?.conversationId).toBe(summary.conversationId);
    expect(w.notifier.sent[0]?.transcript.map((l) => [l.role, l.text])).toContainEqual([
      "patient",
      "Please get me a human",
    ]);
  });

  it("binds an escalation in a replaced conversation to the new one, never the foreign id", async () => {
    const w = world({
      steps: [
        scriptedText("Hi Maria!"),
        scriptedToolUse([
          {
            id: "tu_e",
            name: "escalate_to_human",
            input: { reason: "patient_requested", summary: "Patient asked to speak with the front desk." },
          },
        ]),
        scriptedText("Done."),
      ],
    });
    const mariaConversation = idOf((await w.send("Hello")).summary);
    const walter = await w.send("Get me a human", { patientId: WALTER, conversationId: mariaConversation });

    expect(w.notifier.sent[0]?.conversationId).toBe(walter.summary.conversationId);
    expect(await w.repos.escalations.getForConversation(MARIA, mariaConversation)).toBeNull();
    expect(w.repos.snapshot().escalations.map((e) => e.conversationId)).toEqual([
      walter.summary.conversationId,
    ]);
  });
});

describe("handleChatTurn: rejections before the agent runs", () => {
  it.each([
    ["no sub", { patientId: undefined }],
    ["a sub that isn't a UUID", { patientId: "not-a-uuid" }],
  ])("answers 401 for %s, and counts and stores nothing", async (_name, o) => {
    const w = world();
    const { response } = await w.send("Hello", o);
    expectWellFormed(response);
    expect(response.status).toBe(401);
    expect(response.events).toEqual([expect.objectContaining({ type: "error", code: "UNAUTHORIZED" })]);
    expect(w.llm.requests).toHaveLength(0);
    expect(w.repos.snapshot().conversations).toHaveLength(0);
  });

  it.each([
    ["no body", null],
    ["malformed JSON", "{"],
    ["an empty message", JSON.stringify({ clientMessageId: CLIENT_MESSAGE_ID, text: "  " })],
    [
      "a patientId field",
      JSON.stringify({ clientMessageId: CLIENT_MESSAGE_ID, text: "hi", patientId: WALTER }),
    ],
  ])("answers 400 for %s, without consuming a turn", async (_name, body) => {
    const w = world();
    const { response } = await w.send("", { body });
    expectWellFormed(response);
    expect(response.status).toBe(400);
    expect(response.events[0]).toMatchObject({ type: "error", code: "BAD_REQUEST", retryable: false });
    expect(w.turns.turnsUsed(MARIA, "2026-10-05")).toBe(0);
    expect(w.llm.requests).toHaveLength(0);
  });

  it("enforces the daily turn cap per patient and per clinic day", async () => {
    const w = world({
      cap: 2,
      steps: [scriptedText("1"), scriptedText("2"), scriptedText("W"), scriptedText("3")],
    });
    await w.send("one");
    await w.send("two");
    const third = await w.send("three");

    expectWellFormed(third.response);
    expect(third.response.status).toBe(429);
    expect(third.response.events[0]).toMatchObject({ type: "error", code: "RATE_LIMITED", retryable: false });
    expect(w.llm.requests).toHaveLength(2);
    expect(w.repos.snapshot().conversations).toHaveLength(2);

    // Another patient has their own budget.
    expect((await w.send("hi", { patientId: WALTER })).response.status).toBe(200);
    // 02:00 UTC on the 6th is still 10 PM on the 5th in Eastern Time: the same clinic day, still capped.
    w.clock.set("2026-10-06T02:00:00Z");
    expect((await w.send("late")).response.status).toBe(429);
    // The next clinic day starts fresh (04:00 UTC is midnight ET in October).
    w.clock.set("2026-10-06T04:00:00Z");
    expect((await w.send("four")).response.status).toBe(200);
  });
});

describe("handleChatTurn: failures", () => {
  it("answers 429 when Bedrock throttles before anything streamed, keeps the message, and leaves the turn open", async () => {
    const w = world({ steps: [{ error: throttled }, scriptedText("Back now.")] });
    const { response, summary } = await w.send("Hello");

    expectWellFormed(response);
    expect(response.status).toBe(429);
    expect(response.events).toEqual([expect.objectContaining({ code: "RATE_LIMITED", retryable: true })]);
    // No tool ran, so no closing reply: the turn ends at the patient's message, for a Retry (#104, Q-1).
    const conversationId = idOf(summary);
    expect((await messagesOf(w.repos, MARIA, conversationId)).map((m) => [m.role, textOf(m)])).toEqual([
      ["user", "Hello"],
    ]);

    // A new message closes it first, so the conversation stays valid for the next turn.
    const next = await w.send("Hello again", { conversationId });
    expect(next.response.events.at(-1)?.type).toBe("done");
    expectAlternating(defined(w.llm.requests[1]).messages);
    const stored = await messagesOf(w.repos, MARIA, conversationId);
    expect(stored.map((m) => [m.role, textOf(m)])).toEqual([
      ["user", "Hello"],
      ["assistant", FALLBACK_MESSAGES.interrupted],
      ["user", "Hello again"],
      ["assistant", "Back now."],
    ]);
  });

  it("answers AGENT_UNAVAILABLE for other model errors", async () => {
    const w = world({ steps: [{ error: new Error("boom") }] });
    const { response } = await w.send("Hello");
    expect(response.status).toBe(503);
    expect(response.events[0]).toMatchObject({ code: "AGENT_UNAVAILABLE", retryable: true });
  });

  it("keeps the tool messages when the model fails after a tool ran, and ends the stream with error", async () => {
    const w = world({
      steps: [
        scriptedToolUse([{ id: "tu_1", name: "find_providers", input: {} }]),
        { error: new Error("boom") },
      ],
    });
    const { response, summary } = await w.send("Who works there?");

    expectWellFormed(response);
    expect(response.status).toBe(200); // the status event already went out
    expect(response.events.at(-1)).toMatchObject({ type: "error", code: "AGENT_UNAVAILABLE" });
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(textOf(defined(stored[3]))).toBe(FALLBACK_MESSAGES.interrupted);
    expect(w.turns.traces[0]?.trace.outcome).toBe("error");
  });

  it("ends with an error when the deadline aborts the turn", async () => {
    const w = world({ steps: [scriptedText("never")] });
    const { response } = await w.send("Hello", { signal: AbortSignal.abort() });
    expectWellFormed(response);
    expect(response.events[0]).toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });

  it("closes a turn that was interrupted earlier before appending the new message", async () => {
    const w = world({ steps: [scriptedText("Hi!"), scriptedText("Hello again!")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    // Simulate a crash after the patient's message was stored (no reply).
    await w.repos.conversations.append(MARIA, [
      {
        conversationId,
        seq: 2,
        role: "user",
        content: [{ type: "text", text: "Are you there?" }],
        turnId: "00000000-0000-4000-8000-0000000000ff",
        createdAt: NOW,
      },
    ]);
    const { response } = await w.send("Hello?", { conversationId });

    expect(response.events.at(-1)).toMatchObject({ type: "done", messageId: "msg_000005" });
    const stored = await messagesOf(w.repos, MARIA, conversationId);
    expectAlternating(stored);
    expect(textOf(defined(stored[3]))).toBe(FALLBACK_MESSAGES.interrupted);
    expectAlternating(defined(w.llm.requests[1]).messages);
  });

  it("answers a stale-history append conflict as retryable, without running the agent", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    const listMessages = w.repos.conversations.listMessages.bind(w.repos.conversations);
    // Another turn lands between our read and our append.
    w.deps.repos = {
      ...w.repos,
      conversations: {
        ...w.repos.conversations,
        listMessages: async (p, c) => {
          const out = await listMessages(p, c);
          await w.repos.conversations.append(p, [
            {
              ...defined(out.at(-1)),
              seq: out.length,
              role: "user",
              turnId: "00000000-0000-4000-8000-0000000000ee",
            },
          ]);
          return out;
        },
      },
    };
    const { response } = await w.send("Again", { conversationId });
    expectWellFormed(response);
    expect(response.status).toBe(409);
    expect(response.events[0]).toMatchObject({ code: "AGENT_UNAVAILABLE", retryable: true });
    expect(w.llm.requests).toHaveLength(1);
  });

  it("ends with INTERNAL, not done, when storing the reply fails after the agent ran", async () => {
    const w = world({ steps: [scriptedText("Booked!")] });
    const append = w.repos.conversations.append.bind(w.repos.conversations);
    let calls = 0;
    w.deps.repos = {
      ...w.repos,
      conversations: {
        ...w.repos.conversations,
        append: (p, m) => (++calls === 1 ? append(p, m) : Promise.reject(new Error("dynamo down"))),
      },
    };
    const { response } = await w.send("Hello");
    expectWellFormed(response);
    expect(response.events.some((e) => e.type === "done")).toBe(false);
    expect(response.events.at(-1)).toMatchObject({ type: "error", code: "INTERNAL" });
  });

  it("answers a conflict, not INTERNAL, when another turn wins the race to store the reply", async () => {
    const w = world({ steps: [scriptedText("Booked!")] });
    const append = w.repos.conversations.append.bind(w.repos.conversations);
    let calls = 0;
    w.deps.repos = {
      ...w.repos,
      conversations: {
        ...w.repos.conversations,
        append: (p, m) =>
          ++calls === 1
            ? append(p, m)
            : Promise.reject(new ConversationAppendError("SEQ_CONFLICT", defined(m[0]).conversationId, 1)),
      },
    };
    const { response } = await w.send("Hello");
    expectWellFormed(response);
    expect(response.events.at(-1)).toMatchObject({
      type: "error",
      code: "AGENT_UNAVAILABLE",
      retryable: true,
    });
  });

  it("still resolves and ends the stream when writing to the client throws", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    const { sink, response } = memorySink();
    let writes = 0;
    const broken = {
      ...sink,
      write: () => {
        writes += 1;
        throw new Error("client went away");
      },
    };
    const summary = await handleChatTurn(
      {
        body: JSON.stringify({ clientMessageId: CLIENT_MESSAGE_ID, text: "Hello" }),
        patientId: MARIA,
        requestId: "r",
      },
      w.deps,
      broken,
    );
    expect(writes).toBeGreaterThan(0);
    expect(response.ended).toBe(true);
    expect(summary.terminal).toBe("error");
  });

  it("answers INTERNAL when a repository throws, and still ends the stream", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    w.deps.repos = {
      ...w.repos,
      conversations: { ...w.repos.conversations, append: () => Promise.reject(new Error("dynamo down")) },
    };
    const { response } = await w.send("Hello");
    expectWellFormed(response);
    expect(response.status).toBe(500);
    expect(response.events[0]).toMatchObject({ code: "INTERNAL" });
  });

  it("still answers done when only the trace fails to save", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    w.deps.turns = { ...w.turns, saveTrace: () => Promise.reject(new Error("dynamo down")) };
    const { response } = await w.send("Hello");
    expect(response.events.at(-1)?.type).toBe("done");
    expect(w.logs.some((l) => l.msg === "trace save failed")).toBe(true);
  });
});

describe("handleChatTurn: logging", () => {
  it("logs the turn's timings from the injected monotonic clock", async () => {
    let t = 0;
    const w = world({
      steps: [
        scriptedToolUse([{ id: "tu_1", name: "find_providers", input: { name_query: "Lee" } }]),
        scriptedText("Dr. Lee is in family medicine."),
      ],
      // Every reading is 10 ms after the last, so each timing is a distinct positive number.
      overrides: { monotonicNow: () => (t += 10) },
    });
    await w.send("Who is Dr. Lee?");
    const turnLog = defined(w.logs.find((l) => l.msg === "chat turn"));
    const { firstEventMs, firstTextMs, totalMs } = turnLog;

    expect(typeof firstEventMs).toBe("number");
    expect(typeof firstTextMs).toBe("number");
    expect(typeof totalMs).toBe("number");
    // The status event goes out before the first text, and both before the turn ends.
    expect(firstEventMs as number).toBeGreaterThan(0);
    expect(firstTextMs as number).toBeGreaterThan(firstEventMs as number);
    expect(totalMs as number).toBeGreaterThan(firstTextMs as number);
    expect(turnLog.llmCalls).toEqual([
      expect.objectContaining({ durationMs: expect.any(Number) as unknown }),
      expect.objectContaining({ durationMs: expect.any(Number) as unknown }),
    ]);
  });

  it("logs a tool name the model made up as <unknown>, since it can carry patient text", async () => {
    const w = world({
      steps: [
        scriptedToolUse([{ id: "tu_z", name: "lookup_zebra_unicorn_rash", input: {} }]),
        scriptedText("Sorry, I can't do that."),
      ],
    });
    await w.send("Hello");
    const turnLog = w.logs.find((l) => l.msg === "chat turn");
    expect(turnLog?.tools).toEqual([expect.objectContaining({ name: "<unknown>", ok: false })]);
    expect(JSON.stringify(w.logs)).not.toMatch(/zebra|unicorn/);
  });

  it("logs IDs, timings and tokens, but no message text or tool inputs", async () => {
    const w = world({
      steps: [
        scriptedToolUse([
          {
            id: "tu_e",
            name: "escalate_to_human",
            input: { reason: "frustration", summary: "Patient is upset about the zebra-unicorn rash." },
          },
        ]),
        { error: new Error("boom") },
      ],
    });
    await w.send("My zebra-unicorn rash is driving me mad");
    const turnLog = w.logs.find((l) => l.msg === "chat turn");

    expect(turnLog).toMatchObject({
      requestId: "req-test",
      outcome: "error",
      modelProfile: "sonnet-4.6",
      iterations: 2,
      tools: [expect.objectContaining({ name: "escalate_to_human", ok: true })],
      usage: expect.objectContaining({ inputTokens: 100, outputTokens: 20 }),
    });
    expect(typeof turnLog?.totalMs).toBe("number");
    expect(turnLog?.conversationId).toBeDefined();
    expect(JSON.stringify(w.logs)).not.toMatch(/zebra|unicorn/);
  });
});

describe("handleChatTurn: retries (#104, FR-015)", () => {
  const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const turnLog = (w: World, n: number) => w.logs.filter((l) => l.msg === "chat turn")[n];

  it("stores the clientMessageId on the patient's message only", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    const { summary, clientMessageId } = await w.send("Hello");
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    expect(stored[0]?.clientMessageId).toBe(clientMessageId);
    expect(stored[1]).not.toHaveProperty("clientMessageId");
  });

  it("replays an answered message's stored reply, without a model call, a counted turn, a trace or a second copy", async () => {
    const w = world({ steps: [scriptedText("Hi Maria! How can I help you today?")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    const retry = await w.send("Hello", { conversationId, clientMessageId: first.clientMessageId });

    expectWellFormed(retry.response);
    expect(retry.response.status).toBe(200);
    expect(retry.response.events).toEqual([
      { type: "text_delta", text: "Hi Maria! How can I help you today?" },
      { type: "done", conversationId, messageId: "msg_000001", usage: NO_USAGE },
    ]);
    expect(retry.summary).toMatchObject({ terminal: "done", replayed: true, messagesAppended: 0 });
    expect(first.summary.replayed).toBe(false);
    expect(w.llm.requests).toHaveLength(1);
    expect(w.turns.turnsUsed(MARIA, "2026-10-05")).toBe(1);
    expect(w.turns.traces).toHaveLength(1);
    expect(await messagesOf(w.repos, MARIA, conversationId)).toHaveLength(2);
    expect(turnLog(w, 1)).toMatchObject({ replayed: true, retry: "answered" });
    expect(turnLog(w, 0)).toMatchObject({ replayed: false });
    expect(turnLog(w, 0)?.retry).toBeUndefined();
  });

  it("replays even for a patient at the daily cap, since it makes no model call", async () => {
    const w = world({ cap: 1, steps: [scriptedText("Hi!")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    expect((await w.send("Another", { conversationId })).response.status).toBe(429);
    const retry = await w.send("Hello", { conversationId, clientMessageId: first.clientMessageId });
    // The capped send stored nothing, so "Hello" is still the last patient message.
    expect(retry.response.events.at(-1)).toMatchObject({ type: "done", messageId: "msg_000001" });
  });

  it("replays the closing reply of a turn that failed after a tool ran, as restore shows it", async () => {
    const w = world({
      steps: [
        scriptedToolUse([{ id: "tu_1", name: "find_providers", input: {} }], { text: "Let me check." }),
        { error: new Error("boom") },
      ],
    });
    const first = await w.send("Who works there?");
    expect(first.response.events.at(-1)).toMatchObject({ type: "error", retryable: true });
    const conversationId = idOf(first.summary);
    const retry = await w.send("Who works there?", {
      conversationId,
      clientMessageId: first.clientMessageId,
    });

    expect(retry.response.events).toEqual([
      { type: "text_delta", text: `Let me check.\n\n${FALLBACK_MESSAGES.interrupted}` },
      { type: "done", conversationId, messageId: "msg_000003", usage: NO_USAGE },
    ]);
    expect(w.llm.requests).toHaveLength(2);
  });

  /** A turn whose storing stopped after a tool result: patient message, tool_use, tool_result. */
  const seedStoppedAfterToolResult = (w: World) =>
    w.repos.conversations.append(MARIA, [
      {
        ...seededRow(0, "user", [{ type: "text", text: "Who works there?" }]),
        clientMessageId: SEEDED_CLIENT_MESSAGE_ID,
      },
      seededRow(1, "assistant", [{ type: "tool_use", id: "tu_1", name: "find_providers", input: {} }]),
      seededRow(2, "user", [{ type: "tool_result", toolUseId: "tu_1", content: "{}" }]),
    ]);

  it("closes, then replays, a turn whose storing stopped after a tool result", async () => {
    const w = world();
    const conversationId = SEEDED_CONVERSATION;
    const clientMessageId = SEEDED_CLIENT_MESSAGE_ID;
    await seedStoppedAfterToolResult(w);
    const retry = await w.send("Who works there?", { conversationId, clientMessageId });

    expect(retry.response.events).toEqual([
      { type: "text_delta", text: FALLBACK_MESSAGES.interrupted },
      { type: "done", conversationId, messageId: "msg_000003", usage: NO_USAGE },
    ]);
    const stored = await messagesOf(w.repos, MARIA, conversationId);
    expectAlternating(stored);
    expect(textOf(defined(stored[3]))).toBe(FALLBACK_MESSAGES.interrupted);
    expect(w.llm.requests).toHaveLength(0);
  });

  it("answers the retryable conflict, and replays nothing, when another turn writes before the replay's closing reply", async () => {
    const w = world();
    await seedStoppedAfterToolResult(w);
    w.deps.repos = {
      ...w.repos,
      conversations: {
        ...w.repos.conversations,
        append: () => Promise.reject(new ConversationAppendError("SEQ_CONFLICT", SEEDED_CONVERSATION, 3)),
      },
    };
    const retry = await w.send("Who works there?", {
      conversationId: SEEDED_CONVERSATION,
      clientMessageId: SEEDED_CLIENT_MESSAGE_ID,
    });

    expect(retry.response.status).toBe(409);
    expect(retry.response.events).toEqual([
      expect.objectContaining({ type: "error", retryable: true, conversationId: SEEDED_CONVERSATION }),
    ]);
    expect(retry.summary).toMatchObject({ replayed: false, messagesAppended: 0 });
    expect(await messagesOf(w.repos, MARIA, SEEDED_CONVERSATION)).toHaveLength(3);
  });

  it("answers INTERNAL for a repeat whose stored turn has no reply text to replay", async () => {
    const w = world();
    await w.repos.conversations.append(MARIA, [
      { ...seededRow(0, "user", [{ type: "text", text: "Hi" }]), clientMessageId: SEEDED_CLIENT_MESSAGE_ID },
      seededRow(1, "assistant", [{ type: "tool_use", id: "t", name: "find_providers", input: {} }]),
    ]);
    const retry = await w.send("Hi", {
      conversationId: SEEDED_CONVERSATION,
      clientMessageId: SEEDED_CLIENT_MESSAGE_ID,
    });
    expectWellFormed(retry.response);
    expect(retry.response.events).toEqual([expect.objectContaining({ type: "error", code: "INTERNAL" })]);
    expect(w.llm.requests).toHaveLength(0);
  });

  it("after a failed first turn, names the new conversation on error; Retry runs the agent again without storing the message twice or counting a turn", async () => {
    const w = world({ cap: 1, steps: [{ error: throttled }, scriptedText("Back now.")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    expect(first.response.events).toEqual([expect.objectContaining({ type: "error", conversationId })]);

    const retry = await w.send("Hello", { conversationId, clientMessageId: first.clientMessageId });
    expectWellFormed(retry.response);
    expect(retry.response.events.at(-1)).toMatchObject({
      type: "done",
      conversationId,
      messageId: "msg_000001",
    });
    expect(visibleText(retry.response.events)).toBe("Back now.");
    expect(retry.summary).toMatchObject({ conversationReplaced: false, replayed: false });

    // The model saw the patient's message once, and history stays append-only and alternating.
    expect(
      w.llm.requests[1]?.messages.map((m) => [m.role, m.content.filter((b) => b.type === "text")]),
    ).toEqual([["user", [expect.objectContaining({ type: "text", text: "Hello" })]]]);
    const stored = await messagesOf(w.repos, MARIA, conversationId);
    expect(stored.map((m) => [m.seq, m.role, textOf(m)])).toEqual([
      [0, "user", "Hello"],
      [1, "assistant", "Back now."],
    ]);
    // A new turn ID for the re-run; the patient's message keeps its own (A-5).
    expect(stored[1]?.turnId).toBe(retry.summary.turnId);
    expect(stored[0]?.turnId).toBe(first.summary.turnId);
    expect(stored[0]?.turnId).not.toBe(stored[1]?.turnId);
    // Under a cap of 1, the re-run ran and wasn't counted.
    expect(w.turns.turnsUsed(MARIA, "2026-10-05")).toBe(1);
    expect(w.turns.traces).toHaveLength(2);
    expect(turnLog(w, 1)).toMatchObject({ retry: "interrupted", replayed: false });
  });

  it("re-runs an interrupted turn in a continued conversation on the history before it", async () => {
    const w = world({ steps: [scriptedText("Hi!"), { error: throttled }, scriptedText("Tuesday works.")] });
    const conversationId = idOf((await w.send("Hello")).summary);
    const failed = await w.send("Any time Tuesday?", { conversationId });
    expect(failed.response.events.at(-1)).toMatchObject({ type: "error", conversationId });
    const retry = await w.send("Any time Tuesday?", {
      conversationId,
      clientMessageId: failed.clientMessageId,
    });

    expect(retry.response.events.at(-1)).toMatchObject({ type: "done", messageId: "msg_000003" });
    expect(w.llm.requests[2]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const stored = await messagesOf(w.repos, MARIA, conversationId);
    expect(stored.map((m) => textOf(m))).toEqual(["Hello", "Hi!", "Any time Tuesday?", "Tuesday works."]);
  });

  it("refuses a repeated clientMessageId with different text, storing and counting nothing", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    const odd = await w.send("Goodbye", { conversationId, clientMessageId: first.clientMessageId });

    expectWellFormed(odd.response);
    expect(odd.response.status).toBe(400);
    expect(odd.response.events).toEqual([
      { type: "error", code: "BAD_REQUEST", message: expect.any(String) as unknown, retryable: false },
    ]);
    expect(w.turns.turnsUsed(MARIA, "2026-10-05")).toBe(1);
    expect(await messagesOf(w.repos, MARIA, conversationId)).toHaveLength(2);
    expect(w.llm.requests).toHaveLength(1);
  });

  it("matches only the last patient message: an earlier message's ID is a new send", async () => {
    const w = world({ steps: [scriptedText("1"), scriptedText("2"), scriptedText("3")] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    await w.send("Tuesday?", { conversationId });
    const again = await w.send("Hello", { conversationId, clientMessageId: first.clientMessageId });

    expect(again.summary.replayed).toBe(false);
    expect(w.llm.requests).toHaveLength(3);
    expect((await messagesOf(w.repos, MARIA, conversationId)).map(textOf)).toEqual([
      "Hello",
      "1",
      "Tuesday?",
      "2",
      "Hello",
      "3",
    ]);
  });

  it("never matches another patient's conversation: the same ID there starts a new conversation", async () => {
    const w = world({ steps: [scriptedText("Hi Maria!"), scriptedText("Hi Walter!")] });
    const maria = await w.send("Hello");
    const walter = await w.send("Hello", {
      patientId: WALTER,
      conversationId: idOf(maria.summary),
      clientMessageId: maria.clientMessageId,
    });
    expect(walter.summary).toMatchObject({ conversationReplaced: true, replayed: false });
    expect(visibleText(walter.response.events)).toBe("Hi Walter!");
  });

  it("names a continued conversation on error, but not for the daily cap or a refused body", async () => {
    const w = world({ cap: 2, steps: [scriptedText("Hi!"), { error: new Error("boom") }] });
    const first = await w.send("Hello");
    const conversationId = idOf(first.summary);
    const failed = await w.send("Tuesday?", { conversationId });
    expect(failed.response.events.at(-1)).toMatchObject({ type: "error", conversationId });

    const capped = await w.send("Wednesday?", { conversationId });
    expect(capped.response.status).toBe(429);
    expect(capped.response.events[0]).not.toHaveProperty("conversationId");
    const refused = await w.send("Different", { conversationId, clientMessageId: failed.clientMessageId });
    expect(refused.response.status).toBe(400);
    expect(refused.response.events[0]).not.toHaveProperty("conversationId");
  });

  it("names the conversation on a conflict in a continued conversation, but not when a new one's first append fails", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    const conversationId = idOf((await w.send("Hello")).summary);
    w.deps.repos = {
      ...w.repos,
      conversations: {
        ...w.repos.conversations,
        append: (_p, m) =>
          Promise.reject(new ConversationAppendError("SEQ_CONFLICT", defined(m[0]).conversationId, 2)),
      },
    };
    const conflict = await w.send("Again", { conversationId });
    expect(conflict.response.events).toEqual([
      expect.objectContaining({ type: "error", retryable: true, conversationId }),
    ]);
    const fresh = await w.send("New chat");
    expect(fresh.response.status).toBe(409);
    expect(fresh.response.events[0]).not.toHaveProperty("conversationId");
  });
});
