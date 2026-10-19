/**
 * How a patient message is rendered into what the model sees (#234): one pure function for the loop's new
 * message, the API's stored history and the eval L1 builder, so a spoken message reads the same in every turn.
 */
import { describe, expect, it } from "vitest";

import {
  runAgentTurn,
  ScriptedLlmClient,
  scriptedText,
  SPOKEN_MESSAGE_MARKER,
  withInputMode,
  withoutInputMarker,
  type ContentBlock,
} from "../src";
import { contentOf, turnInput } from "./helpers";

const WORDS: ContentBlock[] = [{ type: "text", text: "book doctor oh car on tuesday" }];
const MARKER: ContentBlock = { type: "text", text: SPOKEN_MESSAGE_MARKER };

describe("withInputMode", () => {
  it("puts the marker block before a spoken message's blocks, leaving the patient's words alone", () => {
    expect(withInputMode(WORDS, "voice")).toEqual([MARKER, ...WORDS]);
  });

  it.each([["text" as const], [undefined]])("returns a %s message's blocks as they are", (mode) => {
    expect(withInputMode(WORDS, mode)).toEqual(WORDS);
  });

  it("returns new arrays and blocks, so a caller can't change the shared marker or its input", () => {
    const spoken = withInputMode(WORDS, "voice");
    expect(spoken).not.toBe(WORDS);
    expect(spoken[0]).not.toBe(withInputMode(WORDS, "voice")[0]);
    expect(withInputMode(WORDS)).not.toBe(WORDS);
  });

  it("says in the marker itself what may be misheard", () => {
    expect(SPOKEN_MESSAGE_MARKER).toMatch(/names, dates, times and providers may be misheard/);
  });
});

describe("withoutInputMarker", () => {
  it("drops the leading marker block and keeps the rest", () => {
    expect(withoutInputMarker([MARKER, ...WORDS])).toEqual(WORDS);
  });

  it("leaves a message without the marker alone", () => {
    expect(withoutInputMarker(WORDS)).toEqual(WORDS);
  });

  it("keeps a message that is nothing but the marker's words (a typed one), and a marker that isn't first", () => {
    expect(withoutInputMarker([MARKER])).toEqual([MARKER]);
    expect(withoutInputMarker([...WORDS, MARKER])).toEqual([...WORDS, MARKER]);
  });
});

describe("runAgentTurn: inputMode", () => {
  const requestMessage = async (inputMode?: "text" | "voice") => {
    const llm = new ScriptedLlmClient([scriptedText("Which doctor?")]);
    const result = await runAgentTurn(
      turnInput(llm, {
        userMessage: WORDS[0]?.type === "text" ? WORDS[0].text : "",
        ...(inputMode ? { inputMode } : {}),
      }),
    );
    return { first: llm.requests[0]?.messages[0], stored: result.newMessages[0] };
  };

  it("sends a spoken message with the marker before the patient's words, and returns it the same way", async () => {
    const { first, stored } = await requestMessage("voice");
    expect(contentOf(first).slice(0, 2)).toEqual([MARKER, ...WORDS]);
    expect(stored?.content).toEqual([MARKER, ...WORDS]);
  });

  it.each([["text" as const], [undefined]])(
    "sends a %s message as the patient's words alone",
    async (mode) => {
      const { first, stored } = await requestMessage(mode);
      expect(contentOf(first).filter((b) => b.type !== "cache_point")).toEqual(WORDS);
      expect(stored?.content).toEqual(WORDS);
    },
  );
});
