/**
 * FR-010: the greeting appears within 1.5 s of page load at p95, signed in and warm (#40, r1/Q-6 (a)).
 *
 * Signs in once as Maria Santos, the `dev` demo patient, and keeps the storage state in a temp directory (deleted at
 * the end). Then, in one signed-in context, it loads /chat 5 times to warm up (discarded) and 50 times measured, one at
 * a time. A sample runs from navigation start (`performance.now()`'s origin) to the first assistant bubble that names
 * Maria, recorded in the page by a MutationObserver; the fallback greeting doesn't name her. A load whose
 * `POST /api/session` didn't return 200 is discarded and counted. Read-only: no turn is sent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, type Response, test } from "@playwright/test";

import { formatGreeting, summarizeGreeting } from "./lib/stats";
import { baseUrlFor, fixtureLogin } from "./support/env";

const WARM_UP = 5;
const SAMPLES = 50;
const FIRST_NAME = "Maria";

declare global {
  interface Window {
    __greetingAt?: number;
  }
}

const isSessionPost = (response: Response) =>
  new URL(response.url()).pathname === "/api/session" && response.request().method() === "POST";

/** One load of /chat: the greeting's time since navigation start, or undefined when the session call wasn't 200. */
async function load(page: Page, url: string): Promise<number | undefined> {
  const session = page.waitForResponse(isSessionPost, { timeout: 30_000 });
  await page.goto(url, { waitUntil: "commit" });
  if ((await session).status() !== 200) return undefined;
  const at = await page.waitForFunction(() => window.__greetingAt, undefined, { timeout: 30_000 });
  return (await at.jsonValue()) as number;
}

test("FR-010: the greeting within 1.5 s of page load at p95 (signed in, warm; read-only)", async ({
  browser,
}) => {
  const env = process.env.FR010_ENV ?? "dev";
  const base = await baseUrlFor(env);
  const login = fixtureLogin("pat-maria");
  const stateDir = mkdtempSync(join(tmpdir(), "sched-fr010-"));
  const statePath = join(stateDir, "state.json");
  try {
    const signIn = await browser.newContext();
    const first = await signIn.newPage();
    await first.goto(`${base}/login`);
    await first.getByLabel("Username").fill(login.username);
    await first.getByLabel("Password").fill(login.password);
    await first.getByLabel("Password").press("Enter");
    await expect(first).toHaveURL(/\/chat$/);
    await signIn.storageState({ path: statePath });
    await signIn.close();

    const context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();
    await page.addInitScript((name) => {
      const observer = new MutationObserver(() => {
        for (const bubble of document.querySelectorAll(".chat__log > li.bubble--assistant")) {
          if (bubble.textContent.includes(name)) {
            window.__greetingAt ??= performance.now();
            observer.disconnect();
            return;
          }
        }
      });
      observer.observe(document, { childList: true, subtree: true, characterData: true });
    }, FIRST_NAME);

    const samples: number[] = [];
    let discarded = 0;
    for (let i = 0; i < WARM_UP + SAMPLES; i += 1) {
      const ms = await load(page, `${base}/chat`);
      if (i < WARM_UP) continue;
      if (ms === undefined) discarded += 1;
      else samples.push(ms);
    }
    await context.close();

    console.log(`samples (ms): ${samples.map((s) => String(Math.round(s))).join(" ")}`);
    const summary = summarizeGreeting(samples, discarded);
    console.log(formatGreeting(summary));
    // A miss is reported, not failed: the PR says so and an M3 issue gets the numbers (r1/Q-6 (a)).
    expect(summary.n).toBeGreaterThan(0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
