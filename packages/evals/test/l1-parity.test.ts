/**
 * L1 builds its own request (`l1Request`) because the agent loop's builder is private to `@sched/agent`
 * (owner decision on PR #71, SMELL-101, option b: a parity test now, the export in #85). This
 * test sends the same conversation through the real `runAgentTurn` and checks that the two requests
 * agree, so a field the loop adds later can't silently go missing from L1.
 */
import { MODEL_PROFILES, runAgentTurn, ScriptedLlmClient, scriptedText, scriptedToolUse } from "@sched/agent";
import { describe, expect, it } from "vitest";

import { createTrialEnvironment, interimSystemPrompt, l1Messages, l1Request, type L1Case } from "../src";
import { l1Case, withoutCachePoints } from "./helpers";

const c = l1Case("l1-emergency-911");

describe.each(["sonnet-4.6", "nova-pro", "gpt-oss-20b"] as const)(
  "l1Request matches the agent loop (%s)",
  (name) => {
    it("same fields, system blocks, tools, and conversation", async () => {
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

      expect(Object.keys(ours).sort()).toEqual(Object.keys(loop).sort());
      expect(ours.system).toEqual(loop.system);
      expect(ours.tools).toEqual(loop.tools);
      expect({ ...ours, system: [], tools: [], messages: [] }).toEqual({
        ...loop,
        system: [],
        tools: [],
        messages: [],
      });
      // Known difference: the loop adds a rolling cache point to the last user message (for the next call);
      // L1 makes exactly one call, so it has no use for one.
      expect(withoutCachePoints(ours)).toEqual(withoutCachePoints(loop));
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
