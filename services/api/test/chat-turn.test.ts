/**
 * Integration tests for the chat turn core (#17): the real agent loop, the real tool registry and
 * executor, in-memory repositories seeded with the clinic-default fixture, a FrozenClock, and a
 * `ScriptedLlmClient` in place of Bedrock. Only the transport is absent.
 */
import {
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
  FrozenClock,
  RecordingNotifier,
  createInMemoryRepositories,
  type InMemoryRepositories,
} from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import {
  INTERRUPTED_REPLY,
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
      body?: string | null;
      signal?: AbortSignal;
    },
  ) => Promise<{
    response: ReturnType<typeof memorySink>["response"];
    summary: Awaited<ReturnType<typeof handleChatTurn>>;
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
      const body =
        o.body !== undefined
          ? o.body
          : JSON.stringify({
              clientMessageId: CLIENT_MESSAGE_ID,
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
      return { response, summary };
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

  it("passes the patient's first name and the clinic time to the system prompt", async () => {
    const w = world({ steps: [scriptedText("Hi!")] });
    await w.send("Hello");
    const system = w.llm.requests[0]?.system.map((b) => ("text" in b ? b.text : "")).join("\n");
    expect(system).toContain("first name is Maria");
    expect(system).toContain("2026");
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
    // The next clinic day starts fresh (04:00 UTC is midnight ET in October).
    w.clock.set("2026-10-06T04:00:00Z");
    expect((await w.send("four")).response.status).toBe(200);
  });
});

describe("handleChatTurn: failures", () => {
  const throttled = Object.assign(new Error("Too many requests"), {
    name: "ThrottlingException",
    $metadata: { httpStatusCode: 429 },
  });

  it("answers 429 when Bedrock throttles before anything streamed, keeps the message, and closes the turn", async () => {
    const w = world({ steps: [{ error: throttled }, scriptedText("Back now.")] });
    const { response, summary } = await w.send("Hello");

    expectWellFormed(response);
    expect(response.status).toBe(429);
    expect(response.events).toEqual([expect.objectContaining({ code: "RATE_LIMITED", retryable: true })]);
    const stored = await messagesOf(w.repos, MARIA, idOf(summary));
    expect(stored.map((m) => [m.role, textOf(m)])).toEqual([
      ["user", "Hello"],
      ["assistant", INTERRUPTED_REPLY],
    ]);

    // The conversation stays valid for the next turn.
    const next = await w.send("Hello again", { conversationId: idOf(summary) });
    expect(next.response.events.at(-1)?.type).toBe("done");
    expectAlternating(defined(w.llm.requests[1]).messages);
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
    expect(textOf(defined(stored[3]))).toBe(INTERRUPTED_REPLY);
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
    expect(textOf(defined(stored[3]))).toBe(INTERRUPTED_REPLY);
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
