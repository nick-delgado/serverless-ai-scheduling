// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordConversation, recordedConversations } from "./run-dir";

const A = "0f8d2c3a-5b6e-4f7a-8c9d-1e2f3a4b5c6d";
const B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-e2e-run-dir-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recordConversation", () => {
  it("appends one line per recorded turn", () => {
    recordConversation(dir, A);
    recordConversation(dir, B);
    const [file] = readdirSync(dir);
    expect(readFileSync(join(dir, file as string), "utf8")).toBe(`${A}\n${B}\n`);
  });

  it("writes nothing without an ID", () => {
    recordConversation(dir, undefined);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes nothing without a run directory", () => {
    expect(() => recordConversation(undefined, A)).not.toThrow();
    expect(() => recordConversation("", A)).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("recordedConversations", () => {
  it("lists a conversation recorded three times once", () => {
    for (let i = 0; i < 3; i += 1) recordConversation(dir, A);
    expect(recordedConversations(dir)).toEqual([A]);
  });

  it("keeps two conversations in the order first recorded", () => {
    recordConversation(dir, B);
    recordConversation(dir, A);
    recordConversation(dir, B);
    expect(recordedConversations(dir)).toEqual([B, A]);
  });

  it("lists none when nothing was recorded", () => {
    expect(recordedConversations(dir)).toEqual([]);
  });
});
