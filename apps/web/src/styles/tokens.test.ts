/** WCAG 2.2 AA contrast for the design tokens in both themes (NFR-005). */
import { describe, expect, it } from "vitest";

import tokensCss from "./tokens.css?raw";

type Tokens = Record<string, string>;

/** The body of `@media <query> { ... }`, up to its matching closing brace. */
function mediaBody(query: string): string {
  const open = tokensCss.indexOf(`@media ${query} {`);
  if (open < 0) throw new Error(`No @media ${query} block`);
  const start = tokensCss.indexOf("{", open) + 1;
  let depth = 1;
  for (let i = start; i < tokensCss.length; i += 1) {
    if (tokensCss[i] === "{") depth += 1;
    else if (tokensCss[i] === "}") depth -= 1;
    if (depth === 0) return tokensCss.slice(start, i);
  }
  throw new Error(`Unclosed @media ${query} block`);
}

function block(selector: string, css: string = tokensCss): Tokens {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No block for ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--color-[\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]),
  );
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, minimum ratio]: 4.5 for text, 3 for focus rings and control borders. */
const PAIRS: [string, string, number][] = [
  ["--color-text", "--color-bg", 4.5],
  ["--color-text", "--color-surface", 4.5],
  ["--color-text", "--color-surface-muted", 4.5],
  ["--color-text-muted", "--color-bg", 4.5],
  ["--color-text-muted", "--color-surface", 4.5],
  ["--color-text-muted", "--color-surface-muted", 4.5],
  ["--color-accent", "--color-bg", 4.5],
  ["--color-accent", "--color-surface", 4.5],
  ["--color-on-accent", "--color-accent", 4.5],
  ["--color-on-accent", "--color-accent-hover", 4.5],
  ["--color-notice-text", "--color-notice-bg", 4.5],
  ["--color-danger", "--color-surface", 4.5],
  ["--color-danger", "--color-bg", 4.5],
  ["--color-focus", "--color-bg", 3],
  ["--color-focus", "--color-surface", 3],
  ["--color-focus", "--color-notice-bg", 3],
  ["--color-border-strong", "--color-surface", 3],
];

const THEMES = {
  light: block(":root"),
  dark: block(':root[data-theme="dark"]'),
};

describe("design tokens", () => {
  it("defines the same color tokens in light and dark", () => {
    expect(Object.keys(THEMES.dark).sort()).toEqual(Object.keys(THEMES.light).sort());
  });

  it("uses one dark palette for the OS preference and for data-theme=dark", () => {
    const osDark = block(':root:not([data-theme="light"])', mediaBody("(prefers-color-scheme: dark)"));
    expect(osDark).toEqual(THEMES.dark);
  });

  describe.each(Object.entries(THEMES))("%s theme", (_, tokens) => {
    it.each(PAIRS)("%s on %s meets %d:1", (fg, bg, min) => {
      const [a, b] = [tokens[fg], tokens[bg]];
      if (!a || !b) throw new Error(`Missing ${fg} or ${bg}`);
      expect(contrast(a, b)).toBeGreaterThanOrEqual(min);
    });
  });
});
