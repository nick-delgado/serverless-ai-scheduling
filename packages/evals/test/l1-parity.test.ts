/**
 * L1 and the agent loop share the profile-derived part of their requests (`profileRequest`, #105, tested
 * in `packages/agent`). What each still builds itself is its tools and messages, so this test sends the
 * same conversation through the real `runAgentTurn` and checks that L1's tools and messages equal the
 * loop's, apart from the rolling message cache point L1 lacks on purpose (it makes one call only).
 * It also checks what L1 hands the builder (32474a5/TEST-1): the rest of L1's request equals
 * `profileRequest(profile, system)`, so L1 passes on its profile and its whole system prompt, with no
 * `maxTokens` override. That compares L1 with the builder, not with the loop.
 */
import {
  MODEL_PROFILES,
  profileRequest,
  runAgentTurn,
  ScriptedLlmClient,
  scriptedText,
  scriptedToolUse,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import { createTrialEnvironment, interimSystemPrompt, l1Messages, l1Request, type L1Case } from "../src";
import { l1Case, withoutCachePoints } from "./helpers";

const c = l1Case("l1-emergency-911");

describe.each(["sonnet-4.6", "nova-pro", "gpt-oss-20b"] as const)(
  "l1Request matches the agent loop (%s)",
  (name) => {
    it("same tools and conversation", async () => {
      const profile = MODEL_PROFILES[name];
      const env = await createTrialEnvironment(c);
      const system = interimSystemPrompt(env.clock.now(), "Walter");
      const messages = l1Messages(c);
      const last = messages.at(-1);
      const lastText = last?.content.find((b) => b.type === "text");
      if (last?.role !== "user" || lastText?.type !== "text")
        throw new Error("case must end with a patient message");

      const llm = new ScriptedLlmClient([scriptedText("ok")]);
      await runAgentTurn({
        history: messages.slice(0, -1),
        userMessage: lastText.text,
        system,
        executor: env.executor,
        llm,
        profile,
        clock: env.clock,
        conversationId: env.conversationId,
        turnId: env.uuid(),
      });
      const loop = llm.requests[0];
      if (loop === undefined) throw new Error("the loop made no request");
      const ours = l1Request(c, profile, system);

      expect(ours.tools).toEqual(loop.tools);
      // Known difference: the loop adds a rolling cache point to the last user message (for the next call);
      // L1 makes exactly one call, so it has no use for one.
      expect(withoutCachePoints(ours)).toEqual(withoutCachePoints(loop));
    });

    it("passes its profile and system prompt to the shared builder, with no override (32474a5/TEST-1)", async () => {
      const profile = MODEL_PROFILES[name];
      const env = await createTrialEnvironment(c);
      const system = interimSystemPrompt(env.clock.now(), "Walter");
      const { tools: _tools, messages: _messages, ...rest } = l1Request(c, profile, system);
      expect(rest).toEqual(profileRequest(profile, system));
    });
  },
);

describe("l1Request renders tool calls and results like the agent loop (2e22f79/TEST-304)", () => {
  it("the loop's second request equals L1's for the same tool call and result", async () => {
    const profile = MODEL_PROFILES["sonnet-4.6"];
    const base = l1Case("l1-lookup-next-appointment"); // Maria: "When's my next appointment?"
    const env = await createTrialEnvironment(base);
    const system = interimSystemPrompt(env.clock.now(), "Maria");
    const first = base.context[0];
    if (first === undefined || !("patient" in first)) throw new Error("case must open with the patient");

    // The loop calls the real get_my_appointments; L1 is given the same call and the result it returned.
    const llm = new ScriptedLlmClient([
      scriptedToolUse([{ id: "tooluse_l1_001", name: "get_my_appointments", input: {} }]),
      scriptedText("ok"),
    ]);
    await runAgentTurn({
      history: [],
      userMessage: first.patient,
      system,
      executor: env.executor,
      llm,
      profile,
      clock: env.clock,
      conversationId: env.conversationId,
      turnId: env.uuid(),
    });
    const loop = llm.requests[1];
    const result = loop?.messages.at(-1)?.content.find((b) => b.type === "tool_result");
    if (loop === undefined || result?.type !== "tool_result") throw new Error("the loop sent no tool result");

    const withCall: L1Case = {
      ...base,
      context: [
        first,
        { tool_call: { tool: "get_my_appointments", args: {} } },
        { tool_result: { tool: "get_my_appointments", result: JSON.parse(result.content) as unknown } },
      ],
    };
    expect(withoutCachePoints(l1Request(withCall, profile, system))).toEqual(withoutCachePoints(loop));
  });
});
