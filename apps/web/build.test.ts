// @vitest-environment node
/**
 * The production build (S5-01, #24): `vite build` writes `index.html` plus hashed files under
 * `assets/`, the layout the web stack's bucket expects, and none of the MSW mock reaches it. The
 * auth code names the Cognito mock's pool behind `import.meta.env.DEV` (S1-02, #25), so its
 * constants are checked too.
 *
 * Voice (S6-02, #29): the Transcribe Streaming SDK is lazy-loaded, so the entry chunk doesn't contain
 * it (r1/A-5); the dev server's `MockTranscriber` is left out (r2/A-4); and the timing record is
 * compiled in only with `VITE_VOICE_TIMING=1` (r2/Q-2 (a)), which a second build checks.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOCK_COGNITO_CONFIG, MOCK_PASSWORD } from "./src/mocks/cognitoUsers";
import { SAMPLE_TRANSCRIPT } from "./src/voice/MockTranscriber";

const here = decodeURIComponent(new URL(".", import.meta.url).pathname);

/** A name for the Transcribe Streaming SDK's code that survives minification. */
const TRANSCRIBE_SDK = "StartStreamTranscription";
/**
 * Strings only the voice timing record and its panel contain: `TIMING_STORAGE_KEY` and the export's
 * `kind` in `src/voice/transcribe/timing.ts`, the panel's class, and the role check's action. Literals,
 * because importing `timing.ts` would pull browser types into this Node-typed file; the build with the
 * flag below fails if one goes stale.
 */
const TIMING_CODE = ["sched.voiceTiming", "sched-voice-timing", "voice-timing", "ListTranscriptionJobs"];

interface Build {
  outDir: string;
  files: string[];
}

let main: Build;
let timing: Build;
let outDir = "";
let files: string[] = [];

async function contents(of: Build = main): Promise<string[]> {
  return Promise.all(of.files.map((file) => readFile(join(of.outDir, file), "utf8")));
}

/** The files of `of` that contain `text`. */
async function filesWith(text: string, of: Build = main): Promise<string[]> {
  const texts = await contents(of);
  return of.files.filter((_file, i) => texts[i]?.includes(text));
}

/** Build the way `npm run build` does, with `env` set (as `deploy-web.sh`'s shell would). */
async function productionBuild(env: Record<string, string> = {}): Promise<Build> {
  const dir = await mkdtemp(join(tmpdir(), "sched-web-build-"));
  // Vitest sets NODE_ENV=test, which makes Vite build with import.meta.env.DEV = true.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  Object.assign(process.env, env);
  try {
    await build({
      configFile: join(here, "vite.config.ts"),
      mode: "production",
      logLevel: "silent",
      build: { outDir: dir, emptyOutDir: true },
    });
  } finally {
    for (const key of Object.keys(env)) Reflect.deleteProperty(process.env, key);
    process.env.NODE_ENV = nodeEnv;
  }
  const built = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
  return { outDir: dir, files: built };
}

beforeAll(async () => {
  main = await productionBuild();
  timing = await productionBuild({ VITE_VOICE_TIMING: "1" });
  ({ outDir, files } = main);
}, 120_000);

afterAll(async () => {
  for (const dir of [main?.outDir, timing?.outDir]) if (dir) await rm(dir, { recursive: true, force: true });
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

  it.each([
    ["pool ID", MOCK_COGNITO_CONFIG.userPoolId],
    ["app client ID", MOCK_COGNITO_CONFIG.userPoolClientId],
    ["password", MOCK_PASSWORD],
  ])("leaves out the Cognito mock's %s", async (_, value) => {
    const texts = await contents();
    expect(files.filter((_file, i) => texts[i]?.includes(value))).toEqual([]);
  });
});

describe("voice in the production build (S6-02, #29)", () => {
  it("lazy-loads the Transcribe Streaming SDK: the entry chunk leaves it out, another chunk has it", async () => {
    const html = await readFile(join(outDir, "index.html"), "utf8");
    const entry = /<script type="module"[^>]*src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(entry).toBeDefined();
    const withSdk = await filesWith(TRANSCRIBE_SDK);
    expect(withSdk).not.toContain(entry);
    expect(withSdk.length).toBeGreaterThan(0);
  });

  it("leaves out the MockTranscriber", async () => {
    expect(await filesWith(SAMPLE_TRANSCRIPT)).toEqual([]);
  });

  it("ships the capture worklet as a script of its own", () => {
    expect(files.some((file) => /^assets\/pcm-worklet-.+\.js$/.test(file))).toBe(true);
  });

  it.each(TIMING_CODE)("has no timing code without VITE_VOICE_TIMING=1 (%s)", async (marker) => {
    expect(await filesWith(marker)).toEqual([]);
  });

  it.each(TIMING_CODE)(
    "has the timing code with VITE_VOICE_TIMING=1 (%s), outside the entry chunk",
    async (marker) => {
      const html = await readFile(join(timing.outDir, "index.html"), "utf8");
      const entry = /<script type="module"[^>]*src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
      const found = await filesWith(marker, timing);
      expect(found.length).toBeGreaterThan(0);
      expect(found).not.toContain(entry);
    },
  );
});
