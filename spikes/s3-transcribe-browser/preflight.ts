/**
 * Pre-flight check before Nick's device runs (#10): drives the page in headless desktop Chrome with a
 * synthetic audio file standing in for the mic (`--use-file-for-fake-audio-capture`), so the whole
 * path runs without a person: Amplify sign-in → Identity Pool credentials (r1/A-8), the denied
 * `ListTranscriptionJobs` call, the 16 kHz probe, and one Transcribe stream per mode through the
 * real worklet. Its numbers are not measurements (r1/Q-6 (a) excludes generated audio); they only
 * prove the path works.
 *
 * The password comes from `DEMO_PASSWORD_MARIA` in the root `.env` and is never printed. The WAV is
 * made with macOS `say` from the ~5 s script, outside the repo. The page must already be served.
 *
 *   npx tsx spikes/s3-transcribe-browser/preflight.ts [--url https://localhost:5175/] [--wav <path>] [--scratch <dir>] [--env-file <root .env>]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { redact } from "./src/redact.ts";
import { SCRIPTS } from "./src/scripts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "https://localhost:5175/" },
    wav: { type: "string" },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    user: { type: "string", default: "maria.santos" },
    scratch: { type: "string", default: tmpdir() },
    "env-file": { type: "string", default: join(here, "..", "..", ".env") },
  },
});

process.loadEnvFile(args["env-file"]);
const password = process.env.DEMO_PASSWORD_MARIA ?? "";
if (!password) throw new Error("DEMO_PASSWORD_MARIA is not set in the root .env");

const scratch = mkdtempSync(join(args.scratch, "s3-preflight-"));
const wav = args.wav ?? join(scratch, "script-5s.wav");
if (!args.wav) {
  execFileSync("say", ["-o", wav, "--data-format=LEI16@48000", SCRIPTS["5s"]]);
  canonicalWav(wav);
}

/**
 * `say` writes JUNK and FLLR chunks before the audio. Chrome's fake capture then plays a beep instead
 * of the file, so rewrite it as a plain 44-byte-header WAV (the "fmt " and "data" chunks only).
 */
function canonicalWav(path: string): void {
  const file = readFileSync(path);
  const chunks = new Map<string, Buffer>();
  for (let at = 12; at + 8 <= file.length;) {
    const id = file.toString("ascii", at, at + 4);
    const size = file.readUInt32LE(at + 4);
    chunks.set(id, file.subarray(at + 8, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  const fmt = chunks.get("fmt ");
  const data = chunks.get("data");
  if (!fmt || !data) throw new Error("say wrote a WAV without fmt or data");
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(fmt.length, 16);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(data.length, 4);
  writeFileSync(path, Buffer.concat([header, fmt, dataHeader, data]));
}

const port = 9333;
const chrome = spawn(
  args.chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(scratch, "profile")}`,
    "--ignore-certificate-errors",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required",
    // The sandboxed audio service can't read the file and captures silence; run it in-process.
    "--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpTarget(): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error("Chrome's DevTools endpoint did not come up");
}

const ws = new WebSocket(await cdpTarget());
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
const consoleLines: string[] = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data)) as {
    id?: number;
    method?: string;
    params?: { type?: string; args?: { value?: unknown }[] };
  };
  if (msg.id) pending.get(msg.id)?.(msg as { result?: unknown });
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error")
    consoleLines.push((msg.params.args ?? []).map((a) => String(a.value)).join(" "));
});
function send(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ result?: unknown; error?: unknown }> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evaluate<T>(expression: string): Promise<T> {
  const reply = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
    result?: { result?: { value?: T }; exceptionDetails?: { text?: string } };
  };
  if (reply.result?.exceptionDetails)
    throw new Error(reply.result.exceptionDetails.text ?? "evaluate failed");
  return reply.result?.result?.value as T;
}
async function waitFor(expression: string, timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate<string>(expression);
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for: ${expression}`);
    await sleep(250);
  }
}
const text = (id: string) => `document.getElementById(${JSON.stringify(id)}).textContent`;

async function open(query: string): Promise<void> {
  await send("Page.navigate", { url: new URL(query, args.url).href });
  await sleep(1500);
  await waitFor(`document.readyState === "complete" && ${text("env")}`, 15_000);
}

interface StoredRun {
  ok: boolean;
  failure?: { kind: string; detail: string };
  latencyMs?: number;
  sendToEndMs?: number;
  transcript: string;
  wer?: number;
  cold: boolean;
  finalCount: number;
  finalsAfterStop: number;
  endMode: string;
  variant: string;
  marks: Record<string, number>;
  ws: { path?: string; closeCode?: number };
  audio: Record<string, unknown>;
}

async function run(variant: "main" | "stabilized", speakMs: number): Promise<StoredRun> {
  await evaluate(`(() => {
    const s = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("change")); };
    s("length", "5s"); s("variant", ${JSON.stringify(variant)}); s("check", "none");
    document.getElementById("start").click();
  })()`);
  await waitFor(`${text("run-status")}.startsWith("Recording") ? "y" : ""`, 20_000);
  await sleep(speakMs);
  await evaluate(`document.getElementById("send").click()`);
  await waitFor(`/OK|FAILED/.test(${text("run-status")}) ? "y" : ""`, 15_000);
  return evaluate<StoredRun>(`JSON.parse(localStorage.getItem("s3:chrome-desktop")).runs.at(-1)`);
}

const report: Record<string, unknown> = { url: args.url };
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await open("./");
  await evaluate(
    `(() => { const b = document.getElementById("browser"); b.value = "chrome-desktop"; b.dispatchEvent(new Event("change")); })()`,
  );
  report.env = await evaluate<string>(text("env"));
  await evaluate(`(() => {
    document.getElementById("username").value = ${JSON.stringify(args.user)};
    document.getElementById("password").value = ${JSON.stringify(password)};
    document.getElementById("signin").click();
  })()`);
  report.auth = await waitFor(
    `/credentials ready|rror|xception/.test(${text("auth-status")}) ? ${text("auth-status")}.replace(/\\(expire.*\\)/, "") : ""`,
    30_000,
  );

  await evaluate(`document.getElementById("scope").click()`);
  report.roleScope = JSON.parse(
    await waitFor(`${text("scope-result")}.includes("denied") ? ${text("scope-result")} : ""`, 30_000),
  );
  await evaluate(`document.getElementById("probe").click()`);
  report.probe16k = JSON.parse(
    await waitFor(`${text("scope-result")}.includes("constructed") ? ${text("scope-result")} : ""`, 30_000),
  );

  // The ~5 s clip loops; 6 s of "speech" then Send.
  const summary = (r: StoredRun) => ({
    ok: r.ok,
    failure: r.failure,
    endMode: r.endMode,
    variant: r.variant,
    cold: r.cold,
    latencyMs: r.latencyMs && Math.round(r.latencyMs),
    sendToEndMs: r.sendToEndMs && Math.round(r.sendToEndMs),
    finals: r.finalCount,
    finalsAfterStop: r.finalsAfterStop,
    wer: r.wer,
    transcript: r.transcript,
    wsPath: r.ws.path,
    wsCloseCode: r.ws.closeCode,
    tapToWsOpenMs: r.marks.wsOpen && Math.round(r.marks.wsOpen),
    tapToFirstResultMs: r.marks.firstResult && Math.round(r.marks.firstResult),
    audio: r.audio,
  });
  report.coldMain = summary(await run("main", 6000));
  report.warmMain = summary(await run("main", 6000));
  report.warmStabilized = summary(await run("stabilized", 6000));

  // What ending the audio iterable does (the SDK closes the socket when the iterable ends).
  await open("./?end=iterable");
  report.endIterable = summary(await run("main", 6000));
  report.consoleErrors = consoleLines.slice(0, 10);
} catch (error) {
  report.error = String(error);
  report.consoleErrors = consoleLines.slice(0, 10);
} finally {
  ws.close();
  chrome.kill();
  await sleep(500);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(redact(JSON.stringify(report, null, 2)));
