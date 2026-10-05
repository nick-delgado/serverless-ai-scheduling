// @vitest-environment node
/**
 * voice.css's level pulse (#28, decision 04f8fc4/SPEC-3 (a)). jsdom loads no CSS, so the component
 * tests see only the class; this reads the stylesheets from disk, as styles/global.test.ts does.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const voiceCss = read("./voice.css");
const globalCss = read("../styles/global.css");

/** The body of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? "";
}

describe("the level dot's pulse", () => {
  it("animates .voice-level--pulse with a keyframe rule that scales the dot, without end", () => {
    const body = ruleBody(voiceCss, ".voice-level--pulse");
    const name = /animation:\s*([\w-]+)\s[^;]*\binfinite\b/.exec(body)?.[1];
    expect(name).toBe("voice-pulse");
    expect(voiceCss).toMatch(/@keyframes voice-pulse\s*\{[^@]*transform:\s*scale\(/);
  });

  it("is stopped by the global reduced-motion rule: no !important of its own to beat it", () => {
    expect(ruleBody(voiceCss, ".voice-level--pulse")).not.toContain("!important");
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/.exec(
        globalCss,
      )?.[1];
    expect(reduced).toMatch(/animation-iteration-count:\s*1\s*!important;/);
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms\s*!important;/);
  });
});
