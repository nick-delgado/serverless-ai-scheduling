import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESTORE_CONVERSATION_ID } from "../mocks/fixtures";
import {
  clearLoginSession,
  conversationToRestore,
  LOGIN_SESSION_STORAGE_KEY,
  readLoginSession,
  writeLoginSession,
} from "./loginSession";

const SUB = "sub-maria.santos";
const OTHER_CONVERSATION = "7d4c2b1a-9e8f-4a6b-8c5d-3e2f1a0b9c8d";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("the stored login session", () => {
  it("round-trips through localStorage, and clearing removes it", () => {
    expect(readLoginSession()).toBeUndefined();
    writeLoginSession({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
    expect(JSON.parse(localStorage.getItem(LOGIN_SESSION_STORAGE_KEY) ?? "null")).toEqual({
      sub: SUB,
      conversationId: RESTORE_CONVERSATION_ID,
    });
    expect(readLoginSession()).toEqual({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
    clearLoginSession();
    expect(localStorage.getItem(LOGIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(readLoginSession()).toBeUndefined();
  });

  it.each([
    ["not JSON", "{"],
    ["the wrong shape", JSON.stringify({ sub: SUB })],
    ["an ID that isn't a UUID", JSON.stringify({ sub: SUB, conversationId: "conv-1" })],
    ["an empty sub", JSON.stringify({ sub: "", conversationId: RESTORE_CONVERSATION_ID })],
  ])("reads %s as no login session", (_, raw) => {
    localStorage.setItem(LOGIN_SESSION_STORAGE_KEY, raw);
    expect(readLoginSession()).toBeUndefined();
  });

  it("treats blocked storage as nothing stored, without throwing", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
    expect(() => writeLoginSession({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID })).not.toThrow();
    expect(readLoginSession()).toBeUndefined();
    expect(() => clearLoginSession()).not.toThrow();
  });
});

describe("conversationToRestore", () => {
  const stored = { sub: SUB, conversationId: RESTORE_CONVERSATION_ID };

  it("restores the conversation this login session has been using, for the same sub", () => {
    expect(conversationToRestore(RESTORE_CONVERSATION_ID, SUB, stored)).toBe(RESTORE_CONVERSATION_ID);
  });

  it.each([
    ["nothing is stored (a new sign-in)", RESTORE_CONVERSATION_ID, SUB, undefined],
    ["the stored sub is someone else's", RESTORE_CONVERSATION_ID, "sub-someone.else", stored],
    ["no sub is known", RESTORE_CONVERSATION_ID, undefined, stored],
    ["the session's conversation is another one", OTHER_CONVERSATION, SUB, stored],
    ["the session has no conversation", null, SUB, stored],
  ] as const)("starts empty when %s", (_, conversationId, sub, storedSession) => {
    expect(conversationToRestore(conversationId, sub, storedSession)).toBeUndefined();
  });
});
