// @vitest-environment node
/**
 * `.visually-hidden` is a global utility (#28 moved it out of chat.css). The files are read from disk:
 * Vitest processes only tokens.css (vite.config.ts), and a `?raw` import of any other CSS file comes
 * back as an empty string, which would let the chat.css check pass without reading anything.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const globalCss = read("./global.css");
const chatCss = read("../chat/chat.css");

const RULE = /(^|\n)\.visually-hidden\s*\{[^}]*clip-path:\s*inset\(50%\)[^}]*\}/;

describe(".visually-hidden", () => {
  it("is defined in global.css", () => {
    expect(globalCss).toMatch(RULE);
  });

  it("is no longer defined in chat.css", () => {
    // Guard against an empty read: chat.css still has its own rules.
    expect(chatCss).toMatch(/\.chat\s*\{/);
    expect(chatCss).not.toMatch(/\.visually-hidden\s*\{/);
  });
});
