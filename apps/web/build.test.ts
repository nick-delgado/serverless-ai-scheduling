// @vitest-environment node
/**
 * The production build (S5-01, #24): `vite build` writes `index.html` plus hashed files under
 * `assets/`, the layout the web stack's bucket expects, and none of the MSW mock reaches it.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = decodeURIComponent(new URL(".", import.meta.url).pathname);

let outDir = "";
let files: string[] = [];

async function contents(): Promise<string[]> {
  return Promise.all(files.map((file) => readFile(join(outDir, file), "utf8")));
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sched-web-build-"));
  // Vitest sets NODE_ENV=test, which makes Vite build with import.meta.env.DEV = true. Build the way
  // `npm run build` does.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      configFile: join(here, "vite.config.ts"),
      mode: "production",
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }
  files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(outDir.length + 1));
}, 60_000);

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("production build", () => {
  it("writes index.html and hashed scripts under assets/", async () => {
    expect(files).toContain("index.html");
    const scripts = files.filter((file) => /^assets\/.+\.js$/.test(file));
    expect(scripts.length).toBeGreaterThan(0);
    const html = await readFile(join(outDir, "index.html"), "utf8");
    expect(scripts.some((script) => html.includes(`/${script}`))).toBe(true);
  });

  it("contains no mock API code and no service worker", async () => {
    expect(files.some((file) => file.includes("mockServiceWorker"))).toBe(false);
    const mockCode = /mockServiceWorker|setupWorker|schedMock|\[MSW\]/;
    const texts = await contents();
    // Report the file and the match, not the whole bundle.
    const hits = files.flatMap((file, i) => {
      const match = texts[i]?.match(mockCode);
      return match ? [`${file}: ${match[0]}`] : [];
    });
    expect(hits).toEqual([]);
  });
});
