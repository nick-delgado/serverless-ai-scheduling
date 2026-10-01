/**
 * L1 builds its own request (`l1Request`) because the agent loop's builder is private to `@sched/agent`
 * (owner decision on PR #71, SMELL-101, option b: a parity test now, the export in #85). This
 * test sends the same conversation through the real `runAgentTurn` and checks that the two requests
 * agree, so a field the loop adds later can't silently go missing from L1.
 */
import { MODEL_PROFILES, runAgentTurn, ScriptedLlmClient, scriptedText, type LlmRequest } from "@sched/agent";
import { describe, expect, it } from "vitest";

import { createTrialEnvironment, interimSystemPrompt, l1Messages, l1Request, loadScenarios } from "../src";

const c = loadScenarios().l1.find((x) => x.id === "l1-emergency-911");
if (c === undefined) throw new Error("no L1 case l1-emergency-911");

/** Messages without cache points: the one known difference (below). */
const withoutCachePoints = (request: LlmRequest) =>
  request.messages.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== "cache_point") }));

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
